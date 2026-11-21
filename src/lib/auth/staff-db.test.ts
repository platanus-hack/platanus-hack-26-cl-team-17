/**
 * Pruebas de la tabla staff contra un Postgres real.
 *   TEST_DATABASE_URL=postgresql://postgres:vigia@localhost:55432/postgres \
 *     node --import tsx --test src/lib/auth/staff-db.test.ts
 * Sin TEST_DATABASE_URL se salta con un aviso.
 */
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const TEST_URL = (process.env.TEST_DATABASE_URL ?? "").trim();
const skip = TEST_URL ? false : "TEST_DATABASE_URL no definido: se omiten las pruebas de staff contra Postgres.";
if (!TEST_URL) console.warn(`[staff-db.test] ${skip}`);

type StaffDb = typeof import("./staff-db");
type PgPool = typeof import("@/lib/store/pg-pool");

describe("staff en Postgres", { skip }, () => {
  // Dominio único por corrida: las pruebas no chocan con datos previos ni entre sí.
  const domain = `t${randomBytes(4).toString("hex")}.vigia.test`;
  const mail = (local: string) => `${local}@${domain}`;
  let db: StaffDb;
  let pg: PgPool;

  const savedAdminEmail = process.env.VIGIA_ADMIN_EMAIL;
  const savedAdminPassword = process.env.VIGIA_ADMIN_PASSWORD;

  before(async () => {
    process.env.DATABASE_URL = TEST_URL;
    process.env.VIGIA_SESSION_SECRET ||= "secreto-de-prueba-staff-db";
    delete process.env.VIGIA_ADMIN_EMAIL;
    delete process.env.VIGIA_ADMIN_PASSWORD;
    db = await import("./staff-db");
    pg = await import("@/lib/store/pg-pool");
  });

  afterEach(() => {
    delete process.env.VIGIA_ADMIN_EMAIL;
    delete process.env.VIGIA_ADMIN_PASSWORD;
  });

  after(async () => {
    if (pg) {
      await pg.getPool().query("delete from staff where email like $1", [`%@${domain}`]);
      await pg.closePool();
    }
    if (savedAdminEmail !== undefined) process.env.VIGIA_ADMIN_EMAIL = savedAdminEmail;
    if (savedAdminPassword !== undefined) process.env.VIGIA_ADMIN_PASSWORD = savedAdminPassword;
  });

  it("crea una cuenta y no expone el hash", async () => {
    const s = await db.createStaff({ email: mail("Ana"), name: "Ana Pérez", role: "officer", password: "clave-de-ana-1" });
    assert.equal(s.email, mail("ana"));
    assert.equal(s.name, "Ana Pérez");
    assert.equal(s.role, "officer");
    assert.equal(s.active, true);
    assert.equal(s.last_login_at, null);
    assert.ok(!Number.isNaN(Date.parse(s.created_at)));
    assert.ok(!("password_hash" in s));
    const pub = db.toStaffPublic(s);
    assert.deepEqual(pub, { id: s.id, email: mail("ana"), name: "Ana Pérez", role: "officer", demo: false });
  });

  it("busca por correo sin distinguir mayúsculas", async () => {
    await db.createStaff({ email: mail("beto"), name: "Beto", role: "operator", password: "clave-de-beto-1" });
    const found = await db.findStaffByEmail(`  ${mail("BETO").toUpperCase()} `);
    assert.ok(found);
    assert.equal(found.email, mail("beto"));
    assert.equal(await db.findStaffByEmail(mail("nadie")), null);
  });

  it("rechaza un correo duplicado (aunque cambie mayúsculas)", async () => {
    await db.createStaff({ email: mail("carla"), name: "Carla", role: "operator", password: "clave-de-carla" });
    await assert.rejects(
      () => db.createStaff({ email: mail("CARLA"), name: "Otra", role: "admin", password: "otra-clave-123" }),
      db.StaffEmailTakenError,
    );
  });

  it("autentica con la contraseña correcta y registra last_login_at", async () => {
    const s = await db.createStaff({ email: mail("dani"), name: "Dani", role: "operator", password: "clave-de-dani-1" });
    assert.equal(await db.authenticate(mail("dani"), "incorrecta-123"), null);
    const ok = await db.authenticate(mail("DANI"), "clave-de-dani-1");
    assert.ok(ok);
    assert.equal(ok.id, s.id);
    assert.ok(ok.last_login_at && !Number.isNaN(Date.parse(ok.last_login_at)));
    assert.equal(await db.authenticate(mail("no-existe"), "clave-de-dani-1"), null);
  });

  it("encuentra la cuenta activa por id y rechaza ids inválidos", async () => {
    const s = await db.createStaff({ email: mail("eli"), name: "Eli", role: "admin", password: "clave-de-eli-12" });
    const byId = await db.findActiveStaffById(s.id);
    assert.equal(byId?.email, mail("eli"));
    assert.equal(await db.findActiveStaffById("no-es-uuid"), null);
    assert.equal(await db.findActiveStaffById("00000000-0000-4000-8000-000000000000"), null);
  });

  it("una cuenta inactiva no inicia sesión ni se resuelve por id", async () => {
    const s = await db.createStaff({ email: mail("fer"), name: "Fer", role: "officer", password: "clave-de-fer-12" });
    await pg.getPool().query("update staff set active = false where id = $1", [s.id]);
    assert.equal(await db.authenticate(mail("fer"), "clave-de-fer-12"), null);
    assert.equal(await db.findActiveStaffById(s.id), null);
    // Sigue existiendo: el correo no queda libre.
    assert.equal((await db.findStaffByEmail(mail("fer")))?.active, false);
  });

  it("lista al personal incluyendo las cuentas creadas", async () => {
    const all = await db.listStaff();
    const mine = all.filter((s) => s.email.endsWith(`@${domain}`)).map((s) => s.email);
    for (const e of ["ana", "beto", "carla", "dani", "eli", "fer"]) assert.ok(mine.includes(mail(e)), e);
    assert.ok(all.every((s) => !("password_hash" in s)));
  });

  it("crea la cuenta administradora inicial solo con las credenciales exactas", async () => {
    const adminEmail = mail("admin");
    process.env.VIGIA_ADMIN_EMAIL = adminEmail.toUpperCase();
    process.env.VIGIA_ADMIN_PASSWORD = "admin-inicial-123";

    // Credenciales distintas: no crea nada.
    assert.equal(await db.authenticate(adminEmail, "otra-clave-999"), null);
    assert.equal(await db.findStaffByEmail(adminEmail), null);

    // Logins simultáneos con las credenciales exactas: una sola cuenta, ambos entran.
    const [a, b] = await Promise.all([
      db.authenticate(adminEmail, "admin-inicial-123"),
      db.authenticate(adminEmail, "admin-inicial-123"),
    ]);
    assert.ok(a && b);
    assert.equal(a.id, b.id);
    assert.equal(a.role, "admin");
    assert.equal(a.name, db.BOOTSTRAP_ADMIN_NAME);
    const count = await pg.getPool().query("select count(*)::int as n from staff where email = $1", [adminEmail]);
    assert.equal(count.rows[0].n, 1);

    // Ya existe: no se vuelve a crear y la contraseña guardada manda.
    assert.equal(await db.ensureBootstrapAdmin(adminEmail, "admin-inicial-123"), false);
    assert.equal(await db.authenticate(adminEmail, "otra-clave-999"), null);
  });

  it("sin VIGIA_ADMIN_* no hay cuenta inicial", async () => {
    assert.equal(await db.ensureBootstrapAdmin(mail("admin2"), "lo-que-sea-123"), false);
    assert.equal(await db.findStaffByEmail(mail("admin2")), null);
  });
});

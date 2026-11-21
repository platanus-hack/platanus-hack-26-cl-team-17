import { test } from "node:test";
import assert from "node:assert/strict";
import {
  channelSuggestions,
  maydaySeqs,
  mergeEntries,
  sortEntries,
  speakerSuggestions,
  tagsBySeq,
} from "./comms-model";
import { ANALYSIS, COMMS } from "./fixtures.test-helpers";

test("etiquetas por entrada: MAYDAY, víctima y recursos; sin análisis no hay etiquetas", () => {
  const tags = tagsBySeq(ANALYSIS);
  assert.deepEqual(tags.get(5)?.map((t) => t.label), ["MAYDAY"]);
  assert.deepEqual(tags.get(3)?.map((t) => t.label), ["Víctima reportada"]);
  assert.deepEqual(tags.get(4)?.map((t) => t.label), ["Solicitud de recursos"]);
  assert.equal(tags.has(2), false, "una llegada rutinaria no se etiqueta");
  assert.equal(tagsBySeq(null).size, 0);
});

test("víctimas negadas por unidad se marcan en verde solo en sus entradas", () => {
  const tags = tagsBySeq({
    ...ANALYSIS,
    events: [],
    victims: { status: "denied_by_unit", detail: "B-3 revisó el segundo piso", entry_seqs: [2] },
  });
  assert.deepEqual(tags.get(2)?.map((t) => [t.label, t.tone]), [["Unidad: sin atrapados", "ok"]]);
});

test("maydaySeqs y orden cronológico estable", () => {
  assert.deepEqual(maydaySeqs(ANALYSIS), [5]);
  const shuffled = [COMMS[3], COMMS[0], COMMS[4], COMMS[1], COMMS[2]];
  assert.deepEqual(
    sortEntries(shuffled).map((e) => e.seq),
    [1, 2, 3, 4, 5],
  );
  const sameTime = [{ ...COMMS[1], seq: 9 }, { ...COMMS[1], seq: 7 }];
  assert.deepEqual(
    sortEntries(sameTime).map((e) => e.seq),
    [7, 9],
  );
});

test("mergeEntries no duplica lo que ya trae el snapshot", () => {
  const confirmed = [COMMS[4], { ...COMMS[4], id: "comm_6", seq: 6, at: "2026-11-21T00:30:00.000Z" }];
  const merged = mergeEntries(COMMS.slice(0, 5), confirmed);
  assert.deepEqual(
    merged.map((e) => e.seq),
    [1, 2, 3, 4, 5, 6],
  );
});

test("sugerencias de emisor y canal", () => {
  const speakers = speakerSuggestions(ANALYSIS, COMMS);
  assert.equal(speakers[0], "Central");
  assert.ok(speakers.includes("RX-15"));
  assert.ok(speakers.includes("OBAC"));
  assert.equal(new Set(speakers.map((s) => s.toLowerCase())).size, speakers.length);
  assert.deepEqual(speakerSuggestions(null, []), ["Central"]);
  assert.deepEqual(channelSuggestions(COMMS), ["Canal 1"]);
});

"""Vocabulario del detector de Vigía: un único lugar donde se define qué busca YOLOE.

Cada entrada es (etiqueta en español, [prompts en inglés]). Los prompts van en inglés porque el
codificador de texto (MobileCLIP2) se entrenó en inglés; la etiqueta es lo que ve el resto de Vigía.

Cada prompt se exporta como una clase propia del ONNX (las clases quedan fijas en el archivo) y el
servidor las vuelve a juntar bajo su etiqueta. Si se cambia esta lista hay que volver a correr
`export.py`.
"""

VOCAB: list[tuple[str, list[str]]] = [
    ("persona", ["person"]),
    ("bombero", ["firefighter"]),
    ("ventana", ["window"]),
    ("puerta", ["door"]),
    ("balcon", ["balcony"]),
    ("fuego", ["fire", "flames"]),
    ("humo", ["smoke"]),
    ("cilindro_gas", ["gas cylinder", "propane tank"]),
    ("cable_caido", ["fallen power line", "electrical cable"]),
    ("poste", ["utility pole"]),
    ("auto", ["car"]),
    ("camioneta", ["pickup truck"]),
    ("camion", ["truck"]),
    ("bus", ["bus"]),
    ("moto", ["motorcycle"]),
    ("bicicleta", ["bicycle"]),
    ("carro_bomba", ["fire truck"]),
    ("ambulancia", ["ambulance"]),
    ("carabineros", ["police car"]),
    ("escalera", ["ladder"]),
    ("grifo", ["fire hydrant"]),
    ("escombros", ["rubble", "debris"]),
    ("agua", ["water leak", "flooding"]),
]

# Etiquetas que se dibujan con color destacado en la imagen anotada.
DESTACADAS = {"persona", "fuego", "humo", "cilindro_gas", "cable_caido"}

# Grupos de etiquetas que suelen describir el mismo objeto (p. ej. una persona que CLIP también
# llama "firefighter"). Dentro de un grupo, cajas muy superpuestas se fusionan y gana la de mayor
# confianza. Cada etiqueta, además, forma grupo consigo misma (sus sinónimos).
GRUPOS: list[set[str]] = [
    {"persona", "bombero"},
    {"auto", "camioneta", "camion", "bus", "carro_bomba", "ambulancia", "carabineros"},
]


def labels() -> list[str]:
    """Etiquetas únicas, en el orden del vocabulario."""
    return [label for label, _ in VOCAB]


def prompts() -> list[tuple[str, str]]:
    """Pares (prompt, etiqueta) en el orden en que quedan como clases del ONNX."""
    return [(p, label) for label, ps in VOCAB for p in ps]

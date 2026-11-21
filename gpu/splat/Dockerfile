# Job de GPU de Vigía: reconstrucción 3D Gaussian Splatting de la escena de un incidente.
#
# CUDA 12.8 + PyTorch 2.10 (cu128) con soporte Blackwell (sm_120, RTX PRO 6000) y Ada (sm_89, L4).
# El driver de Cloud Run (580, CUDA 13.0) es compatible hacia atrás con este runtime.
# Se construye con Cloud Build (deploy/splat-job.sh): no requiere GPU para compilar.
#
# Capas ordenadas de la más cara y estable a la más barata: el código va al final para que
# las reconstrucciones de la imagen reutilicen la caché (torch, gsplat compilado, pesos).
FROM nvidia/cuda:12.8.1-devel-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-dev build-essential git ca-certificates curl ffmpeg \
 && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH

RUN pip install --upgrade "pip==25.2" \
 && pip install torch==2.10.0 torchvision==0.25.0 --index-url https://download.pytorch.org/whl/cu128

COPY requirements.txt /tmp/requirements.txt
RUN pip install -r /tmp/requirements.txt

# gsplat (Apache-2.0) compilado aquí para sm_89 y sm_120. Solo el rasterizador 3DGS y los
# canales que usa el entrenamiento: acorta mucho la compilación.
ARG GSPLAT_COMMIT=512d366b67073d77ca099ede742683c165dfc23b
ARG CUDA_ARCHS="8.9;12.0"
ARG BUILD_JOBS=24
RUN git clone --filter=blob:none https://github.com/nerfstudio-project/gsplat.git /opt/src/gsplat \
 && cd /opt/src/gsplat \
 && git checkout "$GSPLAT_COMMIT" \
 && git submodule update --init --depth 1 gsplat/cuda/csrc/third_party/glm \
 && TORCH_CUDA_ARCH_LIST="$CUDA_ARCHS" MAX_JOBS="$BUILD_JOBS" \
    BUILD_3DGS=1 BUILD_EXPERIMENTAL=0 NUM_CHANNELS="1,2,3,4,8,16,32" \
    pip install --no-build-isolation . \
 && cd / && rm -rf /opt/src/gsplat
RUN python -c "import importlib.util as u, gsplat; assert u.find_spec('gsplat.csrc'), 'gsplat sin kernels CUDA'; print('gsplat', gsplat.__version__)"

# VGGT (código bajo la VGGT License de Meta, uso comercial permitido salvo militar).
# --no-deps: su pyproject fija numpy<2; sus dependencias reales ya están en requirements.txt.
ARG VGGT_COMMIT=a288dd0f14786c93483e45524328726ab7b1b4ce
RUN pip install --no-deps "vggt @ git+https://github.com/facebookresearch/vggt.git@${VGGT_COMMIT}"

# Pesos de VGGT-1B horneados en la imagen (CC BY-NC 4.0: uso no comercial). Para uso comercial
# cambia a facebook/VGGT-1B-Commercial (requiere aprobación en Hugging Face y un token).
ARG VGGT_REPO=facebook/VGGT-1B
ARG VGGT_REVISION=860abec7937da0a4c03c41d3c269c366e82abdf9
ARG VGGT_SHA256=f164acf60724910d8fe1578bb499d800850c7bb0948db7555c413f9fbe60467e
RUN mkdir -p /opt/models/vggt \
 && curl -fsSL --retry 5 -o /opt/models/vggt/model.safetensors \
      "https://huggingface.co/${VGGT_REPO}/resolve/${VGGT_REVISION}/model.safetensors" \
 && echo "${VGGT_SHA256}  /opt/models/vggt/model.safetensors" | sha256sum -c -

ENV VGGT_WEIGHTS=/opt/models/vggt/model.safetensors \
    SPLAT_WORKDIR=/tmp/splat

WORKDIR /app
COPY splat/ /app/splat/
RUN python -m compileall -q /app/splat

ENTRYPOINT ["python", "-m", "splat.main"]

FROM node:24.18.1-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7

COPY --chown=0:0 --chmod=0555 repository-integrity.mjs node-quality.mjs /forgex-verifier/

USER 65532:65532
WORKDIR /workspace
ENTRYPOINT []
CMD ["/forgex-verifier/node-quality"]

FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

ENV HOME=/home/rig

RUN mkdir -p /home/rig /workspace \
    && chown -R node:node /home/rig /workspace

USER node
WORKDIR /workspace
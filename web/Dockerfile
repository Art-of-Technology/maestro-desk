# Respovia agent SPA + portal — self-hosted (Dokploy) image. Build context =
# web/ (set "Docker Context Path" to web in Dokploy). Pure static serve: no
# bundler in production (see CLAUDE.md) — nginx serves the tree as-is, exactly
# like Vercel's static hosting did. The security headers that lived in
# web/vercel.json (CSP etc.) are re-declared in nginx.conf — keep the two in
# sync while both hosts exist.
FROM nginx:1.29-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY . /usr/share/nginx/html
# nginx.conf must stay in the build context for the COPY above (so it can't be
# .dockerignore'd) — drop it from the served tree instead.
RUN rm /usr/share/nginx/html/nginx.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

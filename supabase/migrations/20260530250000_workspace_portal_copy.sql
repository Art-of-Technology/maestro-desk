-- Per-workspace customizable copy on the customer portal. Optional —
-- workspaces that don't set these fall back to the existing
-- platform-default text ("Help & support", no intro paragraph, no
-- footer). Already-shipped fields (name, logo_url, primary_color)
-- handle the visual chrome; this batch handles the copy.
--
-- Lengths are generous-but-bounded so admins can write a real
-- paragraph without us paying for unbounded TEXT in the GET /:slug/
-- config response.

alter table workspaces
  add column portal_tagline text check (portal_tagline is null or length(portal_tagline) <= 100),
  add column portal_intro   text check (portal_intro   is null or length(portal_intro)   <= 1000),
  add column portal_footer  text check (portal_footer  is null or length(portal_footer)  <= 500);

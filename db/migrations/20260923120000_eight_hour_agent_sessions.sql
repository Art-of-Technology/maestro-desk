-- Apply the same absolute lifetime to sessions issued before this release.
update "session"
set "expiresAt" = "createdAt" + interval '8 hours'
where "expiresAt" > "createdAt" + interval '8 hours';

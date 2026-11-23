-- Preserve the account in each saved link; leave custom URLs and other brands alone.
update customers c
set backoffice_url = regexp_replace(c.backoffice_url,
  '^https://bo[.]spacecasino[.]com/Member/Detail/',
  'https://backofficev2.spacecasino.com/members/')
from workspaces w
where w.id = c.workspace_id
  and w.maestro_brand_id = '58d5016a-91bb-49e6-a9be-b3f36f08afde'
  and c.erased_at is null
  and c.backoffice_url ~ '^https://bo[.]spacecasino[.]com/Member/Detail/[0-9]+$';

-- Keep invitations distinct from accounts deliberately disabled by an admin.
alter table workspace_members add column invitation_pending boolean not null default false;
alter table workspace_members add constraint pending_members_are_inactive
  check (not invitation_pending or not active);

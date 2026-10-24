-- Personal appearance follows the account across workspaces.
alter table users
  add column navigation_position text not null default 'left'
    check (navigation_position in ('left', 'top')),
  add column colour_scheme text not null default 'violet'
    check (colour_scheme in ('violet', 'blue', 'teal'));

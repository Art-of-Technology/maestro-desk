// Only verified brand routes belong here. Never derive a host from a brand name.
const SPACE_CASINO = '58d5016a-91bb-49e6-a9be-b3f36f08afde';

export function playerBackofficeUrl(brandId: string | null, memberId: string | null): string | null {
  if (brandId !== SPACE_CASINO || !memberId || !/^\d+$/.test(memberId)) return null;
  return `https://bo.spacecasino.com/Member/Detail/${memberId}`;
}

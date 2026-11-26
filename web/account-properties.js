export const tagColors = { purple: '紫色', blue: '蓝色', green: '绿色', orange: '橙色', pink: '粉色', teal: '青色', gray: '灰色' };
const names = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
const english = new Intl.DisplayNames(['en'], { type: 'region' });
const aliases = new Map();
for (const code of 'US GB JP DE FR CN CA AU ID MY IN SG TH VN PH KR BR MX ES IT NL NZ AE SA TR RU ZA TW HK MO CH AT BE SE NO DK FI PL PT IE IL AR CL CO PE EG'.split(' ')) {
  for (const value of [code, names.of(code), english.of(code)]) aliases.set(value.toLowerCase(), code);
}
for (const [alias, code] of Object.entries({ UK: 'GB', USA: 'US', GBR: 'GB', DEU: 'DE', JPN: 'JP', IDN: 'ID', MYS: 'MY', IND: 'IN', 印尼: 'ID', 马来西亚: 'MY', 韩国: 'KR' })) aliases.set(alias.toLowerCase(), code);

export function accountCountry(account) {
  const raw = String(account.country || '').trim();
  if (!raw) return { value: '__unknown__', label: '未知国家' };
  const code = aliases.get(raw.toLowerCase()) || (/^[a-z]{2}$/i.test(raw) ? raw.toUpperCase() : '');
  const label = code ? names.of(code) : raw;
  return { value: code || raw, label: code && label !== code ? `${label}（${code}）` : label };
}

export function validateAccountFilters(input = {}) {
  const fail = () => { throw Object.assign(new Error('请检查账号的平台、国家、标签或搜索条件。'), { status: 400 }); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail();
  const allowed = ['id', 'keyword', 'platform', 'country', 'platforms', 'countries', 'tags', 'tagMatch', 'untagged'];
  if (Object.keys(input).some(key => !allowed.includes(key))) fail();
  for (const key of ['id', 'keyword', 'platform', 'country']) if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 100)) fail();
  for (const key of ['platforms', 'countries', 'tags']) if (input[key] !== undefined && (!Array.isArray(input[key]) || input[key].length > 50 || input[key].some(value => typeof value !== 'string' || !value.trim() || value.length > 100))) fail();
  if (input.tagMatch !== undefined && !['any', 'all'].includes(input.tagMatch)) fail();
  if (input.untagged !== undefined && typeof input.untagged !== 'boolean') fail();
  if (input.untagged && input.tags?.length) fail();
  return input;
}

export function matchesAccount(account, filters = {}) {
  const platforms = filters.platforms?.length ? filters.platforms : filters.platform ? [filters.platform] : [];
  const countries = (filters.countries?.length ? filters.countries : filters.country ? [filters.country] : []).map(country => accountCountry({ country: country === '__unknown__' ? '' : country }).value);
  const tags = filters.tags || [];
  const assigned = account.tags || [];
  return (!filters.id || account.id === filters.id) &&
    (!platforms.length || platforms.some(platform => platform.toLowerCase() === account.platform?.toLowerCase())) &&
    (!countries.length || countries.includes(accountCountry(account).value)) &&
    (!filters.keyword || `${account.id} ${account.name} ${account.alias || ''}`.toLowerCase().includes(filters.keyword.trim().toLowerCase())) &&
    (!filters.untagged || !assigned.length) &&
    (!tags.length || (filters.tagMatch === 'all' ? tags.every(tag => assigned.some(item => item.id === tag)) : tags.some(tag => assigned.some(item => item.id === tag))));
}

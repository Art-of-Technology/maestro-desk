export function templateCategory(template) {
  return template.category?.trim() || 'Uncategorised';
}

export function templateCategories(templates) {
  return [...new Set(templates.map(templateCategory))].sort((a, b) => a.localeCompare(b));
}

export function filterTemplates(templates, query = '', category = '') {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return templates.filter(template => {
    if (category && templateCategory(template) !== category) return false;
    const text = `${template.name || ''} ${templateCategory(template)} ${template.subject || ''} ${template.text || template.body || ''}`.toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  });
}

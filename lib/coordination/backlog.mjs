// Shared BACKLOG.md row parser (I-128/M9). The row format used to be parsed
// by four modules with silently diverging field names (title vs description,
// migration string vs migrationRequired boolean); a column change would have
// broken each copy differently. The superset shape keeps every historical
// field name working.

const REQUIREMENT_ROW_ID = /^(I|F|B)-\d{3,}$/;

export function parseBacklogRows(source) {
  const rows = new Map();
  for (const line of (source ?? '').split(/\r?\n/)) {
    const cells = line.split('|');
    const id = cells[1]?.trim();
    if (!REQUIREMENT_ROW_ID.test(id ?? '')) continue;
    const description = cells[2]?.trim() ?? '';
    const migration = cells[3]?.trim() ?? '';
    rows.set(id, {
      id,
      title: description,
      description,
      migration,
      migrationRequired: migration === '是',
      status: cells[4]?.trim() ?? '',
      version: cells[5]?.trim() ?? '',
      notes: cells[6]?.trim() ?? '',
      line,
    });
  }
  return rows;
}

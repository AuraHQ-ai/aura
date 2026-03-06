import pg from 'pg';
const c = new pg.Client({connectionString: process.env.DATABASE_URL});
await c.connect();

// Positional lexeme ordering
const longQ = 'Tali mentioned she is working on the My Home GTM strategy with Jakub targeting five million registered homeowners';
const {rows: posLex} = await c.query(`
  SELECT lexeme, positions FROM unnest(to_tsvector('english', $1)) 
  ORDER BY positions[1]
`, [longQ]);
console.log('=== Positional vs alphabetical lexeme order ===');
console.log('Positional:', posLex.map(r => r.lexeme).join(', '));

// Document frequency for common vs rare terms
console.log('\n=== Document frequency (IDF proxy) ===');
const terms = ['tali', 'realadvisor', 'engag', 'score', 'bug', 'joan', 'swiss', 'churn', 'kerryan', 'jakub'];
for (const t of terms) {
  const {rows: [{n}]} = await c.query(`
    SELECT count(*) as n FROM memories 
    WHERE to_tsvector('english', coalesce(content, '')) @@ to_tsquery('english', $1)
  `, [t]);
  console.log(`  "${t}": ${n} / 20,683 memories (${(n/20683*100).toFixed(1)}%)`);
}

// Per-term UNION vs single OR: demonstrate the drowning effect
console.log('\n=== DROWNING EFFECT: single OR pool ===');
const {rows: orPool} = await c.query(`
  SELECT id, left(content, 80) as preview,
    ts_rank_cd(to_tsvector('english', coalesce(content, '')), to_tsquery('english', 'tali | realadvisor')) as score
  FROM memories
  WHERE to_tsvector('english', coalesce(content, '')) @@ to_tsquery('english', 'tali | realadvisor')
  ORDER BY ts_rank_cd(to_tsvector('english', coalesce(content, '')), to_tsquery('english', 'tali | realadvisor')) DESC
  LIMIT 25
`);
const taliInOrPool = orPool.filter(r => r.preview.toLowerCase().includes('tali')).length;
console.log(`Single OR pool top-25: ${taliInOrPool} Tali memories`);
console.log('Top 5:');
orPool.slice(0,5).forEach((r,i) => console.log(`  ${i+1}. [score=${r.score}] ${r.preview}`));

// Show: all scores are identical because ts_rank has no IDF
const uniqueScores = [...new Set(orPool.map(r => r.score))];
console.log(`Unique scores in top-25: [${uniqueScores.join(', ')}] -- ${uniqueScores.length === 1 ? 'ALL IDENTICAL (no IDF!)' : 'varied'}`);

await c.end();

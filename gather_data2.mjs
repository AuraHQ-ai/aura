import pg from 'pg';
const c = new pg.Client({connectionString: process.env.DATABASE_URL});
await c.connect();

// Verify: the "Tali" matches in vector top-100 are actually Natalia, not Tali Leff
const {rows} = await c.query(`
  SELECT left(content, 120) as preview FROM memories 
  WHERE lower(content) LIKE '%tali%' 
  AND embedding IS NOT NULL
  AND (lower(content) LIKE '%tali leff%' OR lower(content) LIKE '%fractional%' OR lower(content) LIKE '%cmo%' OR lower(content) LIKE '%my home%')
  LIMIT 5
`);
console.log('=== Actual Tali Leff memories (should be informative) ===');
rows.forEach(r => console.log(' ', r.preview));

// ts_rank_cd normflag comparison
console.log('\n=== ts_rank_cd normflag comparison on a real Tali memory ===');
const {rows: norms} = await c.query(`
  SELECT 
    ts_rank_cd(to_tsvector('english', content), to_tsquery('english', 'tali'), 0) as norm0,
    ts_rank_cd(to_tsvector('english', content), to_tsquery('english', 'tali'), 1) as norm1,
    ts_rank_cd(to_tsvector('english', content), to_tsquery('english', 'tali'), 4) as norm4,
    length(content) as len,
    left(content, 80) as preview
  FROM memories
  WHERE to_tsvector('english', coalesce(content, '')) @@ to_tsquery('english', 'tali')
  ORDER BY length(content) DESC
  LIMIT 5
`);
norms.forEach(r => console.log(`  len=${r.len} norm0=${r.norm0} norm1=${r.norm1} norm4=${r.norm4} | ${r.preview}`));

// Also check short ones
console.log('\nShort Tali memories:');
const {rows: shortOnes} = await c.query(`
  SELECT 
    ts_rank_cd(to_tsvector('english', content), to_tsquery('english', 'tali'), 0) as norm0,
    ts_rank_cd(to_tsvector('english', content), to_tsquery('english', 'tali'), 4) as norm4,
    length(content) as len,
    left(content, 80) as preview
  FROM memories
  WHERE to_tsvector('english', coalesce(content, '')) @@ to_tsquery('english', 'tali')
  ORDER BY length(content) ASC
  LIMIT 5
`);
shortOnes.forEach(r => console.log(`  len=${r.len} norm0=${r.norm0} norm4=${r.norm4} | ${r.preview}`));

// How to_tsvector orders lexemes - demonstrate the alphabetization problem
console.log('\n=== to_tsvector alphabetization problem ===');
const longQ = 'Tali mentioned she is working on the My Home GTM strategy with Jakub targeting five million registered homeowners';
const {rows: [{lexemes}]} = await c.query(`SELECT tsvector_to_array(to_tsvector('english', $1)) as lexemes`, [longQ]);
console.log('Input:', longQ);
console.log('Lexemes (alphabetized by to_tsvector):', lexemes.join(', '));
console.log('First 8:', lexemes.slice(0,8).join(', '));
console.log('Problem: "tali" is at position', lexemes.indexOf('tali') + 1, 'of', lexemes.length);

// Can we get positional order instead?
const {rows: posLex} = await c.query(`
  SELECT word, positions[1] as pos FROM ts_debug('english', $1) 
  WHERE alias NOT IN ('blank', 'asciiword') OR token != ' '
  ORDER BY positions[1]
`, [longQ]);
// Actually let's use a different approach
const {rows: posLex2} = await c.query(`
  SELECT lexeme, positions FROM unnest(to_tsvector('english', $1)) 
  ORDER BY positions[1]
`, [longQ]);
console.log('\nLexemes in positional order:', posLex2.map(r => `${r.lexeme}[${r.positions}]`).join(', '));

await c.end();

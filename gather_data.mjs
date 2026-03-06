import pg from 'pg';
import https from 'https';
const c = new pg.Client({connectionString: process.env.DATABASE_URL});
await c.connect();

function embed(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'text-embedding-3-large', input: text, dimensions: 1536 });
    const req = https.request({ hostname: 'api.openai.com', path: '/v1/embeddings', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY, 'Content-Type': 'application/json' }
    }, res => { let d=''; res.on('data', c => d+=c); res.on('end', () => resolve(JSON.parse(d).data[0].embedding)); });
    req.on('error', reject); req.write(body); req.end();
  });
}

const QUERY = 'what does Tali do at RealAdvisor?';
const emb = await embed(QUERY);

// Top-25 vector: how many mention Tali?
const {rows: top25} = await c.query(`
  SELECT id, left(content, 80) as preview, 1 - (embedding <=> $1::vector) as sim
  FROM memories WHERE embedding IS NOT NULL
  ORDER BY embedding <=> $1::vector
  LIMIT 25
`, [JSON.stringify(emb)]);

const taliIn25 = top25.filter(r => r.preview.toLowerCase().includes('tali')).length;
console.log('=== VECTOR SEARCH: "what does Tali do at RealAdvisor?" ===');
console.log('Tali memories in top-25:', taliIn25, '/ 25');
console.log('Similarity range:', top25[0].sim.toFixed(3), 'to', top25[24].sim.toFixed(3));
console.log('Top 5 results:');
top25.slice(0,5).forEach((r,i) => console.log(`  ${i+1}. [sim=${r.sim.toFixed(3)}] ${r.preview}`));

// Top-100
const {rows: top100} = await c.query(`
  SELECT id, content FROM memories WHERE embedding IS NOT NULL
  ORDER BY embedding <=> $1::vector LIMIT 100
`, [JSON.stringify(emb)]);
const taliIn100 = top100.filter(r => r.content.toLowerCase().includes('tali')).length;
console.log('Tali memories in top-100:', taliIn100, '/ 100');

// Where does best Tali memory rank?
const {rows: allRanked} = await c.query(`
  SELECT rank, left(content, 100) as preview FROM (
    SELECT content, ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) as rank
    FROM memories WHERE embedding IS NOT NULL
  ) t
  WHERE lower(content) LIKE '%tali%'
  ORDER BY rank LIMIT 5
`, [JSON.stringify(emb)]);
console.log('\nFirst Tali memories by vector rank:');
allRanked.forEach(r => console.log(`  rank ${r.rank}: ${r.preview}`));

// Lexeme extraction examples
console.log('\n=== LEXEME EXTRACTION ===');
const queries = [
  'what does Tali do at RealAdvisor?',
  'who is Tali Leff?',
  'Swiss team_id null bug affecting CH accounts',
  'engagement score formula weights and thresholds',
  'Tali mentioned she is working on the My Home GTM strategy with Jakub targeting five million registered homeowners'
];
for (const q of queries) {
  const {rows: [{lexemes}]} = await c.query(`SELECT tsvector_to_array(to_tsvector('english', $1)) as lexemes`, [q]);
  console.log(`"${q.slice(0,60)}${q.length>60?'...':''}" -> ${lexemes.length} lexemes: [${lexemes.join(', ')}]`);
}

// websearch_to_tsquery AND semantics test
console.log('\n=== AND vs OR SEMANTICS ===');
const {rows: [{and_count}]} = await c.query(`
  SELECT count(*) as and_count FROM memories 
  WHERE to_tsvector('english', coalesce(content, '')) @@ websearch_to_tsquery('english', 'Tali RealAdvisor')
`);
const {rows: [{or_count}]} = await c.query(`
  SELECT count(*) as or_count FROM memories 
  WHERE to_tsvector('english', coalesce(content, '')) @@ to_tsquery('english', 'tali | realadvisor')
`);
const {rows: [{tali_only}]} = await c.query(`
  SELECT count(*) as tali_only FROM memories 
  WHERE to_tsvector('english', coalesce(content, '')) @@ to_tsquery('english', 'tali')
  AND NOT to_tsvector('english', coalesce(content, '')) @@ to_tsquery('english', 'realadvisor')
`);
console.log(`websearch_to_tsquery (AND) "Tali RealAdvisor": ${and_count} matches`);
console.log(`to_tsquery (OR) "tali | realadvisor": ${or_count} matches`);
console.log(`Tali-only (no RealAdvisor): ${tali_only} memories KILLED by AND semantics`);

await c.end();

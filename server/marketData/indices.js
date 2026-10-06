/* The 8 instruments Bullsy knows about. These ids are Bullsy's own; provider
   symbols live only inside the provider adapter. */
export const INDICES = [
  { id: 'NIFTY50',     name: 'NIFTY 50',                 short: 'NIFTY 50', emoji: '📈', group: 'benchmark' },
  { id: 'SENSEX',      name: 'SENSEX',                   short: 'SENSEX',   emoji: '📊', group: 'benchmark' },
  { id: 'NIFTYBANK',   name: 'NIFTY BANK',               short: 'BANK',     emoji: '🏦', group: 'sector' },
  { id: 'NIFTYIT',     name: 'NIFTY IT',                 short: 'IT',       emoji: '💻', group: 'sector' },
  { id: 'NIFTYAUTO',   name: 'NIFTY AUTO',               short: 'AUTO',     emoji: '🚗', group: 'sector' },
  { id: 'NIFTYFIN',    name: 'NIFTY FINANCIAL SERVICES', short: 'FIN SERV', emoji: '💰', group: 'sector' },
  { id: 'NIFTYFMCG',   name: 'NIFTY FMCG',               short: 'FMCG',     emoji: '🛒', group: 'sector' },
  { id: 'NIFTYPHARMA', name: 'NIFTY PHARMA',             short: 'PHARMA',   emoji: '💊', group: 'sector' }
];
export const INDEX_IDS = INDICES.map(i => i.id);
export const INDEX_BY_ID = Object.fromEntries(INDICES.map(i => [i.id, i]));

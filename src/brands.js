'use strict';

/**
 * Referentiel des noms / enseignes de stations-service.
 *
 * Le flux officiel des prix ne contient ni le nom ni l'enseigne du point de
 * vente. On le complete avec le referentiel publie sur data.gouv.fr (enrichi
 * par OpenStreetMap), joint sur l'identifiant officiel de la station.
 */

/**
 * Enseignes connues, de la plus specifique a la plus generique : l'ordre
 * compte, "Carrefour Market" doit etre teste avant "Carrefour".
 */
const KNOWN_BRANDS = [
  'TotalEnergies', 'Total Access', 'Total',
  'Carrefour Market', 'Carrefour Contact', 'Carrefour Express', 'Carrefour',
  'E.Leclerc', 'Leclerc',
  'Intermarche', 'Intermarché', 'Netto',
  'Super U', 'Hyper U', 'U Express', 'Systeme U', 'Système U',
  'Auchan', 'Simply Market',
  'Casino', 'Geant Casino', 'Géant Casino',
  'Cora', 'Match', 'Colruyt', 'Costco', 'Lidl', 'Aldi', 'Monoprix',
  'Esso Express', 'Esso',
  'Avia', 'BP', 'Shell', 'Agip', 'Eni', 'Elan', 'Dyneff', 'Vito',
  'Bolloré Energy', 'Bollore Energy', 'Oil France', 'Argedis', 'Access'
];

const normalize = (value) =>
  (value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

/** Deduit l'enseigne a partir du nom normalise du referentiel. */
function guessBrand(name) {
  const haystack = normalize(name);
  if (!haystack) return null;
  for (const brand of KNOWN_BRANDS) {
    if (haystack.includes(normalize(brand))) return brand;
  }
  return null;
}

/**
 * Parseur CSV minimal (RFC 4180) : gere les champs entre guillemets, les
 * virgules et guillemets echappes. Evite une dependance supplementaire pour un
 * fichier de ~350 Ko a la structure simple et stable.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } // guillemet echappe
        else inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') { inQuotes = true; }
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (char !== '\r') { field += char; }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  return rows;
}

/**
 * Transforme le CSV du referentiel en Map( idStation -> { nom, marque } ).
 */
function buildBrandIndex(csvText) {
  const rows = parseCsv(csvText);
  if (!rows.length) return new Map();

  const header = rows[0].map((h) => h.trim());
  const idIdx = header.indexOf('id_station_officiel');
  const nameIdx = header.indexOf('nom_normalise');
  if (idIdx === -1 || nameIdx === -1) return new Map();

  const index = new Map();
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    const id = Number(row[idIdx]);
    const name = (row[nameIdx] || '').trim();
    if (!Number.isFinite(id) || !name) continue;
    index.set(id, { nom: name, marque: guessBrand(name) });
  }
  return index;
}

module.exports = { buildBrandIndex, guessBrand };

'use strict';

/**
 * Les 6 carburants publies par le flux officiel.
 * `field` = prefixe des colonnes du jeu de donnees amont (<field>_prix / <field>_maj).
 * `code`  = identifiant utilise par l'API interne et le front-end.
 */
const FUELS = [
  { code: 'e10',    field: 'e10',    label: 'E10',    fullLabel: 'SP95-E10' },
  { code: 'sp98',   field: 'sp98',   label: 'SP98',   fullLabel: 'Sans plomb 98' },
  { code: 'sp95',   field: 'sp95',   label: 'SP95',   fullLabel: 'Sans plomb 95' },
  { code: 'gazole', field: 'gazole', label: 'Gazole', fullLabel: 'Gazole (Diesel)' },
  { code: 'e85',    field: 'e85',    label: 'E85',    fullLabel: 'Superethanol E85' },
  { code: 'gplc',   field: 'gplc',   label: 'GPL',    fullLabel: 'GPL carburant' }
];

const FUEL_CODES = FUELS.map((f) => f.code);
const isFuelCode = (code) => FUEL_CODES.includes(code);

module.exports = { FUELS, FUEL_CODES, isFuelCode };

'use strict';

const EARTH_RADIUS_KM = 6371;
const toRad = (deg) => (deg * Math.PI) / 180;

/** Distance orthodromique (haversine) entre deux points, en kilometres. */
function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

/** 1 degre de longitude en km, a une latitude donnee. */
function kmPerLonDegree(lat) {
  return 111.32 * Math.cos(toRad(lat));
}

const KM_PER_LAT_DEGREE = 110.574;

module.exports = { haversineKm, kmPerLonDegree, KM_PER_LAT_DEGREE };

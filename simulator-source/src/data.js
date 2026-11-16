/* Farm, plan options, weather scenarios, economics and sources. Weather (climate.js) and soils are real data; the farm layout,
   field outlines and acres are illustrative; prices and costs are dated values with sources below (oats and rye are placeholders). */
window.FS = window.FS || {};
FS.data = {
  sample: false,

  farm: {
    name: 'Sample farm',
    place: 'Story County, Iowa',
    lat: 42.03, lon: -93.47,
    // Field outlines are in view units on a 1000 x 640 canvas, drawn as seen from above (north up).
    // The layout is illustrative, not a real farm; acres are sample values.
    view: { w: 1000, h: 640 },
    countyAwcMmPerM: 180,   // county reference available water, mm per m (Story County soils, rounded)
    fields: [
      { id: 'north', name: 'North 80', acres: 80, lastCrop: 'corn', soil: { name: 'Coland-Terril complex, 1 to 5 percent slopes', awcMmPerM: 189, aws150cm: 28.32, drainage: 'Poorly drained', hydgrp: 'C/D', slopePct: 2, point: [-93.48, 42.04] },
        poly: [[560, 30], [970, 30], [970, 300], [560, 300]] },
      { id: 'creek', name: 'Creek 40', acres: 40, lastCrop: 'corn', soil: { name: 'Coland clay loam, 0 to 2 percent slopes, occasionally flooded', awcMmPerM: 180, aws150cm: 27.07, drainage: 'Poorly drained', hydgrp: 'C/D', slopePct: 1, point: [-93.47, 42.03] },
        poly: [[260, 30], [520, 30], [520, 150], [340, 150], [340, 300], [260, 300]] },
      { id: 'west', name: 'West 40', acres: 40, lastCrop: 'soybean', soil: { name: 'Canisteo clay loam, Bemis moraine, 0 to 2 percent slopes', awcMmPerM: 180, aws150cm: 27.0, drainage: 'Poorly drained', hydgrp: 'C/D', slopePct: 1, point: [-93.5, 42.05] },
        poly: [[30, 350], [320, 350], [320, 450], [30, 450]] },
      { id: 'south', name: 'South 120', acres: 120, lastCrop: 'soybean', soil: { name: 'Clarion loam, Bemis moraine, 6 to 10 percent slopes, moderately eroded', awcMmPerM: 180, aws150cm: 27.07, drainage: 'Well drained', hydgrp: 'B', slopePct: 8, point: [-93.46, 42.02] },
        poly: [[360, 350], [970, 350], [970, 610], [30, 610], [30, 490], [360, 490]] }
    ],
    // Areas that are not fields (for scenery): farmstead block top-left, gravel roads.
    scenery: {
      farmstead: [[30, 30], [230, 30], [230, 300], [30, 300]],
      roads: [ [[0, 325], [1000, 325]], [[540, 0], [540, 325]] ],
      creek: [[250, 640], [300, 560], [345, 500], [340, 400], [300, 330]]
    }
  },

  // Next-season plans. The timeline runs weekly from mid-November 2026 to mid-November 2027.
  // Each plan is a list of crop stages with ISO dates; 'none' means no crop growing.
  plans: {
    'soy':        { label: 'Soybean (current plan)', after: 'corn',
                    sequence: [ { crop: 'none', from: '2026-11-16' }, { crop: 'soybean', from: '2027-05-15', harvest: '2027-10-05' }, { crop: 'none', from: '2027-10-06' } ] },
    'rye-soy':    { label: 'Cereal rye cover, then soybean', after: 'corn',
                    sequence: [ { crop: 'rye', from: '2026-11-16', end: '2027-05-05' }, { crop: 'soybean', from: '2027-05-18', harvest: '2027-10-05' }, { crop: 'none', from: '2027-10-06' } ] },
    'corn-corn':  { label: 'Corn after corn', after: 'corn',
                    sequence: [ { crop: 'none', from: '2026-11-16' }, { crop: 'corn', from: '2027-04-28', harvest: '2027-10-15' }, { crop: 'none', from: '2027-10-16' } ] },
    'oats-cover': { label: 'Oats, then a summer cover crop', after: 'corn',
                    sequence: [ { crop: 'none', from: '2026-11-16' }, { crop: 'oats', from: '2027-04-05', harvest: '2027-07-20' }, { crop: 'rye', from: '2027-08-05', end: '2027-11-15' } ] },
    'corn':       { label: 'Corn (current plan)', after: 'soybean',
                    sequence: [ { crop: 'none', from: '2026-11-16' }, { crop: 'corn', from: '2027-04-28', harvest: '2027-10-15' }, { crop: 'none', from: '2027-10-16' } ] },
    'rye-corn':   { label: 'Cereal rye cover, then corn', after: 'soybean',
                    sequence: [ { crop: 'rye', from: '2026-11-16', end: '2027-04-20' }, { crop: 'corn', from: '2027-05-02', harvest: '2027-10-15' }, { crop: 'none', from: '2027-10-16' } ] },
    'soy-soy':    { label: 'Soybean after soybean', after: 'soybean',
                    sequence: [ { crop: 'none', from: '2026-11-16' }, { crop: 'soybean', from: '2027-05-15', harvest: '2027-10-05' }, { crop: 'none', from: '2027-10-06' } ] }
  },
  // which plans each field may choose (by its last crop)
  planOptions: {
    corn: ['soy', 'rye-soy', 'corn-corn', 'oats-cover'],
    soybean: ['corn', 'rye-corn', 'soy-soy']
  },

  // Weather to replay on next season: the NAMED list shown first in the dropdown (API_V2.md section 1). Any season can also be replayed
  // with the id 'y' + year (FS.engine.scenario). 'year' is the real NASA POWER season replayed; years were computed from FS.data.climate:
  // typical = the season closest to the 1982-2025 median in BOTH June-August rain and May-September growing degree-days (seasons
  // 1982-83 skipped: no radiation, so ET0 is Hargreaves). 1984, the earlier choice, matched rain only and is the 4th coolest season.
  weatherScenarios: [
    { id: 'typical', label: 'Typical season (2011 weather)', phrase: 'a typical season\'s weather (2011)', year: 2011,
      note: 'Closest of the 44 seasons to the middle of the record in both June-August rain (293 mm here against a 1982-2025 median of 322 mm) and summer warmth; Iowa corn 172 bu/acre (USDA NASS).' },
    { id: 'drought2012', label: '2012 drought and heat', phrase: 'a 2012-style drought', year: 2012,
      note: 'Iowa corn 137 bu/acre vs 172 in 2011 (USDA NASS); the 2nd driest June-August of the 44 seasons here.' },
    { id: 'drought1988', label: '1988 drought', phrase: 'a 1988-style drought', year: 1988,
      note: 'The driest April-June of the 44 seasons here and the 5th driest June-August; Iowa corn 84 bu/acre (USDA NASS).' },
    { id: 'wetSpring', label: 'Wet spring (2008)', phrase: 'a wet spring like 2008', year: 2008,
      note: 'The wettest April-June of the 44 seasons here (511 mm in NASA POWER), ending in the June 2008 floods.' },
    { id: 'dry2023', label: '2023 dry summer', phrase: 'a 2023-style dry summer', year: 2023,
      note: 'Dry summer, yet Iowa corn made 201 bu/acre (USDA NASS).' },
    { id: 'lateFreeze', label: 'Late spring frost (1997)', phrase: 'the 1997 season, the latest spring frost here', year: 1997,
      note: 'Last frost night of spring (0 C or colder in NASA POWER) on 15 May 1997, the latest in 44 seasons.' },
    { id: 'earlyFrost', label: 'Early fall frost (1991)', phrase: 'the 1991 season, the earliest fall frost here', year: 1991,
      note: 'First frost night of fall (0 C or colder in NASA POWER) on 19 September 1991, the earliest in 44 seasons.' }
  ],

  // Prices and costs for the money model. Dollar figures are before insurance, at the dates below.
  economics: {
    price: { corn: 4.60, soybean: 12.10, oats: 3.50 },           // $/bu; corn and soybean = 2026/27 season-average farm price (Nov 2026 WASDE); oats price is a PLACEHOLDER
    normalYield: { corn: 211, soybean: 61, oats: 80 },             // bu/acre; corn and soybean from the ISU 2026 budgets; oats is a placeholder
    costPerAcre: { corn: 911.98, cornAfterCorn: 960.02, soybean: 680, oats: 420, rye: 37 }, // full cost incl. land; ISU 2026 A1-20 via secondary summaries; oats and rye are placeholders
    nitrogen: { lbPerAcreCornAfterSoy: 146, lbPerAcreCornAfterCorn: 190, dollarsPerLb: 0.57 },
    volatility: { corn: 0.15, soybean: 0.13 },                     // RMA 2026 price volatility factors
    costShareRye: 30,                                              // IDALS 2026 first-time cover crop cost-share, $/acre
    costShareCapAcres: 160,                                        // IDALS 2026: cost-share is paid on at most 160 acres per farm
    asOf: '2026-11-14',
    sources: {
      price: 'Corn $4.60 and soybean $12.10 per bushel: USDA WASDE November 2026, 2026/27 season-average farm price (reported by DTN, 10 Nov 2026). Oats $3.50 is a rough guess with no source.',
      costs: 'Corn $911.98, corn after corn $960.02 and the 211 bu/acre budget yield: Iowa State University Ag Decision Maker A1-20, January 2026, read through secondary summaries (Fencerow, Iowa Farm Bureau). Soybean about $680 at 61 bu/acre: Iowa Soybean Association summary of the same budgets, sources conflict. Oats $420 and 80 bu/acre are rough guesses with no source. Rye $37 is a rough guess with no source.',
      nitrogen: '146 lb N/acre for corn after soybean: Iowa State MRTN 2022. 190 lb for corn after corn is a working figure. $0.57 per lb N from anhydrous at $938/ton (DTN, November 2026).',
      volatility: 'RMA 2026 volatility factors, via farmdoc daily (March 2026).',
      costShare: 'Iowa Department of Agriculture and Land Stewardship cover crop cost-share 2026: $30/acre first-time, 160-acre cap; not combinable with the crop insurance discount.'
    }
  },

  sources: {
    power: { label: 'NASA POWER', url: 'https://power.larc.nasa.gov/docs/services/api/temporal/' },
    openmeteo: { label: 'Open-Meteo archive (ERA5)', url: 'https://open-meteo.com/en/docs/historical-weather-api' },
    nrcs: { label: 'NRCS Soil Data Access', url: 'https://sdmdataaccess.sc.egov.usda.gov/WebServiceHelp.aspx' },
    isu: { label: 'Iowa State A1-20 crop budgets', url: 'https://www.extension.iastate.edu/agdm/crops/pdf/a1-20.pdf' },
    wasde: { label: 'USDA WASDE, November 2026', url: 'https://esmis.nal.usda.gov/sites/default/release-files/796142/wasde1126.pdf' },
    rma: { label: 'RMA prices and volatility (farmdoc)', url: 'https://farmdocdaily.illinois.edu/2026/03/projected-prices-and-volatility-factors-for-2026.html' },
    idals: { label: 'Iowa cover crop cost-share', url: 'https://iowaagriculture.gov/news/cover-crop-cost-share-program-2026' },
    fao56: { label: 'FAO Paper 56 (ET0)', url: 'https://www.fao.org/4/x0490e/x0490e0e.htm' },
    fao33: { label: 'FAO Paper 33 (Ky)', url: 'https://fao.org/4/i2800e/i2800e02.pdf' },
    nass: { label: 'USDA NASS Quick Stats (Iowa yields)', url: 'https://quickstats.nass.usda.gov/' }
  },

  initialControls: {
    weather: { scenario: 'typical', tempShift: 0, rainChange: 0, events: [] },   // events: up to 3 of { type: 'dryspell'|'wetspell'|'heatwave', month: 1-12, severity: 'moderate'|'severe' } (API_V3 section 2)
    crops:   { plans: { north: 'soy', creek: 'soy', west: 'corn', south: 'corn' },
               trialAcres: { north: 80, creek: 40, west: 40, south: 120 },
               plantShiftDays: 0,
               soilWaterPct: 0 },   // how much more (+) or less (-) water the soil holds than the soil survey says, -60..40 % (set from the chat)   // days earlier (-) or later (+) than the usual planting dates, -21..21 in steps of 7 (API_V3 section 1)
    other:   { priceChange: 0, nitrogenChange: 0, contracted: 30, costShare: false, priority: 'balanced' }   // priority: 'balanced' | 'profit' | 'risk' | 'cover'
  }
};

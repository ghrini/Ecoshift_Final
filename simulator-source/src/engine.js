/* Field Shift simulation engine: FS.engine.run({farm, controls, baseline}) -> result (format in CONTRACT.md and API_V2.md).
   A daily crop and soil-water model that replays one real NASA POWER season (FS.data.climate) through each field,
   then reports weekly. Deterministic, synchronous, no network.

   Model (see VALIDATION.md for how it was checked):
   - FAO-56 daily soil-water balance over a 1.5 m soil profile in two layers: the root zone, which deepens as the crop
     grows, and the soil below the roots, which is refilled by water draining from above and is taken into the root
     zone as roots reach it. Each season starts from the soil water left at the end of the real season before it.
   - Growing-degree-day crop stages; the corn hybrid and soybean variety are matched to this location's season length.
   - Planting waits for a workable field: warm enough, no rain on the day and the day before, and a topsoil that has
     dried after rain (FAO-56 chapter 7 evaporation layer).
   - Yield % of normal = 100 x (Sw / median Sw)^gamma x (fill / median fill)^eDur x PD x Yf x Yrot x Ycc / norm
       Sw  = Yw x Yh x Yww: FAO-33 stage-weighted water stress, heat (exp(-b x hot degree-days)) and waterlogging.
             This weather-stress part is over-dispersed (raw 2012 corn ~ 20% of normal), so it is compressed with
             the fitted exponent gamma.
       fill = length of grain fill (days-equivalent at the season's own rate of development); warmer = shorter.
       PD (planting date), Yf (frost), Yrot (rotation), Ycc (cereal rye) are sourced multipliers applied AFTER the
             compression and NOT compressed, so their published sizes survive (corn after corn ~ -8%).
       norm = median of the same product for the baseline rotation over all seasons: the median season = 100.
   - gamma, b and eDur are fitted by tools/validate.py with leave-one-year-out against USDA NASS Iowa yields 1982-2025. The check shows skill in the
     two big droughts only; in ordinary years the model does no better than the yield trend (VALIDATION.md, "Round 3 audit").
   - Warming (temperature slider, shift > 0): heat is not identifiable from the NASS data (fitted b = 0), so each field-season's yield is held to at least
     the published average loss, see WARM_LOSS. Risk numbers (worst 5 seasons) widen the weather deviations to the observed spread, see RISK_K. */
window.FS = window.FS || {};
(function () {
  'use strict';

  // ================================================================ MODEL CONSTANTS
  // Tags: SOURCED = from a cited source; FITTED = fitted to NASS yields (tools/validate.py, VALIDATION.md);
  //       DESIGN = a design value chosen by the team, to be checked.
  var DAY = 864e5;
  var N_DAYS_C = 365;                      // (= N_DAYS, declared below)
  function CAL_M(d) { return new Date(Date.UTC(2026, 10, 16) + d * 864e5).getUTCMonth() + 1; }
  var START = Date.UTC(2026, 10, 16);      // page timeline start (16 Nov 2026); season index 0 = 16 Nov
  var N_DAYS = 365, N_WEEKS = 53;          // 29 Feb is dropped from the data, so 2027 has 365 days (CLIMATE_FORMAT.md)
  var ET_PER_C = 0.03;                     // ET0 x (1 + 0.03 x tempShift) (DESIGN, "acceptable" per CLIMATE_FORMAT.md; probably low)

  // ---- FITTED parameters. Written by `python3 tools/validate.py --write`; do not hand-edit between the markers.
  // <fit:auto>
  var FIT = {
    corn: { gamma: 0.315, heatB: 0.00000, eDur: 0.238 },
    soybean: { gamma: 0.462, heatB: 0.00013, eDur: 0.000 },
    zMaxCorn: 1.5, startMode: 'fixed', crMax: 6
  };
  // </fit:auto>
  // ---- Leave-one-year-out check against NASS (written by tools/validate.py --write).
  // <validation:auto>
  var VALIDATION = {"source": "USDA NASS Quick Stats, Iowa state yields", "years": [1982, 2025], "corn": {"process": {"r": 0.482, "rho": 0.239, "rmsePct": 9.86, "rmseTrendPct": 11.26, "skill": 0.125}, "ridge": {"r": 0.584, "rho": 0.561, "rmsePct": 9.07, "rmseTrendPct": 11.26, "skill": 0.195}, "gbm": {"r": 0.199, "rho": 0.233, "rmsePct": 11.95, "rmseTrendPct": 11.26, "skill": -0.061}}, "soybean": {"process": {"r": 0.271, "rho": 0.046, "rmsePct": 9.46, "rmseTrendPct": 9.82, "skill": 0.037}, "ridge": {"r": 0.552, "rho": 0.591, "rmsePct": 8.23, "rmseTrendPct": 9.82, "skill": 0.162}, "gbm": {"r": 0.404, "rho": 0.367, "rmsePct": 9.08, "rmseTrendPct": 9.82, "skill": 0.076}}, "riskK": {"corn": 1.565, "soybean": 2.204}, "text": "Checked against USDA NASS Iowa yields 1982-2025: the model catches the big droughts (1988, 2012), but in ordinary years it does no better than the long-term yield trend, and in any one season it has a typical error of 10 points of a normal crop. Small differences between plans are not reliable."};
  // </validation:auto>

  // Crop thresholds, degree-days F from planting, for the REFERENCE hybrid/variety. Corn 86/50 F method: emergence 110,
  // V6 475, R1 1420, R6 2700 (SOURCED: central-Iowa extension tables quoted in the build plan); R4 2190, R5 2450 are the
  // usual extension stage values (approximate, not re-verified here), R5.5 (half milk line) taken midway (DESIGN).
  // Soybean 90/1000/2000/2200 base 50 F and oats thresholds are DESIGN values.
  // flowS..flowE = flowering window (corn R1-150 .. R1+300, SOURCED shape in the plan; soybean and oats DESIGN);
  // ripeS = start of the "ripening" water-stress stage; mat = maturity (corn R6 black layer, soybean R8, oats DESIGN).
  // Every threshold after emergence is scaled by (matched maturity / reference maturity), see HYBRID.
  var CROPS = {
    corn:    { base: 50, gE: 110, gV: 475, gR1: 1420, flowS: 1270, flowE: 1720, ripeS: 2450, mat: 2700, kcMid: 1.20, pTab: 0.55,
               ky: [0.40, 1.50, 0.50, 0.20], gMid: 650, gSlope: 110, gPeak: 0.95, senS: 2100, tcrit: 'c29', root: 1.0 },
    soybean: { base: 50, gE: 90, gV: 400, gR1: 1000, flowS: 850, flowE: 1250, ripeS: 2000, mat: 2200, kcMid: 1.15, pTab: 0.50,
               ky: [0.20, 0.80, 1.00, 0.20], gMid: 700, gSlope: 110, gPeak: 0.90, senS: 1700, tcrit: 'c30', root: 0.8 },
    oats:    { base: 32, gE: 150, gV: 500, gR1: 1700, flowS: 1500, flowE: 2000, ripeS: 2300, mat: 2700, kcMid: 1.15, pTab: 0.55,
               ky: [0.30, 0.80, 0.60, 0.20], gMid: 700, gSlope: 150, gPeak: 0.85, senS: 2300, tcrit: 'c29', zMax: 1.0 }
  };
  // Ky: corn flowering 1.50 (SOURCED: FAO-33, disputed vs 2.3), other corn and soybean Ky (SOURCED in the plan); oats Ky DESIGN.
  // Kc mid corn 1.20 and soybean 1.15 (SOURCED: FAO-56 Table 12, Clemson); oats and rye DESIGN. Kc = 0.30 + (Kc_mid - 0.30) x G (DESIGN).
  // Rooting depth Zr = 0.2 + (Zmax - 0.2) x min(1, GDD since emergence / GDD_R1) (DESIGN shape). Zmax corn = FIT.zMaxCorn
  // (FITTED: 1.2 or 1.5 m tried, 1.5 m = the depth the NRCS water-holding value covers), soybean = 0.8 x corn (`root`, DESIGN), oats 1.0 (DESIGN).
  var PROFILE_Z = 1.5;                     // soil profile depth, m (SOURCED: NRCS aws0150wta is water held in the top 150 cm)
  var YW_STAGE_FLOOR = 0.40, YW_FLOOR = 0.10;   // DESIGN: the linear Ky relation is valid only for moderate deficits (FAO-33)
  var KC_MIN = 0.30;                       // bare soil / emergence Kc (SOURCED: FAO-56 Table 12 corn initial)
  var P_ADJ = 0.04;                        // p = p_tab + 0.04 x (5 - ETc) (SOURCED: FAO-56 ch. 8)
  var RYE = { kcMid: 1.00, pTab: 0.55, zr: 0.8,          // DESIGN
              gFallTau: 250, gFallMax: 0.6,              // G = 0.6 x (1 - exp(-GDDfall/250)) in fall (build plan, DESIGN values)
              gWinter: 0.25,                             // DESIGN: live rye stays visibly green in winter (plan text 0.1)
              gSpringMax: 0.9, gSpringGdd: 450,          // rise to 0.9 by 450 spring GDD, base 0 C (build plan, DESIGN values)
              springFrom: '03-15', fall0: 150,           // spring GDD from 15 Mar (DESIGN); rye seeded before 16 Nov has 150 C-d (DESIGN)
              bioFall: 6.0, bioFallMax: 1500, bioFallCarry: 0.3, bioSpring: 5.0, bioMax: 6700,   // biomass kg/ha (DESIGN)
              ccCorn: 0.04, ccCornRef: 4000, kShort: 1.0, kLong: 0.3, ccShortDays: 7,           // Ycc corn: 4.1% ISU INRC anchor (SOURCED)
              ccSoy: 0.995 };                            // rye before soybean (DESIGN)
  var FALLOW_ZR = 1.0;                     // DESIGN: active layer of bare soil and residue
  var START_DEPLETION = 0.25;              // DESIGN: first season (1982) and startMode 'fixed' start 75% full on 16 Nov
  var RUNOFF_P0 = 5, RUNOFF_FLAT = 0.10, RUNOFF_STEEP = 0.25, STEEP_SLOPE = 6;   // SOURCED shape in plan; fractions DESIGN
  var SURPLUS_CAP = 0.30;                  // DESIGN: water above field capacity held on poorly drained soil, share of root-zone TAW
  // Water-table contribution (capillary rise, the CR term of the FAO-56 water balance, eq. 85): once roots are deeper than WT_ROOT_Z,
  // CR = crMax x f(drainage) x root-zone depletion share, mm/day. Iowa State extension: the water table was ~1.5-1.8 m deep at corn
  // silking and roots reached it; root access to shallow groundwater supplied 1-46% of yield in model studies, most in dry years
  // (SOURCED mechanism: crops.extension.iastate.edu, "Starting soil moisture and water table depth", 2024). crMax is FITTED;
  // the drainage-class shares and WT_ROOT_Z are DESIGN (poorly drained soils have the shallowest water tables).
  var WT_ROOT_Z = 1.0, WT_SHARE = [ [/very poorly/i, 1.0], [/somewhat poorly/i, 0.8], [/poorly/i, 1.0], [/moderately well/i, 0.5] ], WT_SHARE_WELL = 0.3, WT_SHARE_REF = 0.7;
  var DRAIN_K = [ [/very poorly/i, 0.40], [/somewhat poorly/i, 0.70], [/poorly/i, 0.60], [/moderately well/i, 0.85] ];   // DESIGN: share of surplus drained per day (1 = well drained)
  // Topsoil workability (FAO-56 ch. 7 evaporation layer, Ze = 0.10 m): the field is workable once the top 10 cm has dried past the
  // readily evaporable water REW after rain. REW 9 mm, TEW 25 mm (SOURCED range: FAO-56 Table 19, silty clay loam / clay loam).
  var TOP_REW = 9, TOP_TEW = 25;
  // Heat: Yh = exp(-b x HDD), HDD = sum over emergence..maturity of max(0, Tmax - Tcrit), Tcrit = meta.heatMatch c29 (corn) / c30 (soybean)
  // (log-linear form after Schlenker and Roberts); b = FIT.<crop>.heatB (FITTED; the fit put b at or near 0, see VALIDATION.md).
  // Hard freeze (killing frost): Tmin <= -2 C on NASA POWER (SOURCED agronomic threshold, about 28 F).
  // Checked against three NOAA GHCN-Daily stations around Ames (AMES 8 WSW, AMES MUNI AP, COLO; raw/ghcn/, tools/frost_compare.py):
  // POWER fall night lows run -0.1 to +1.2 C vs the stations and its median first -2 C night (24-27 Oct) is a few days LATER than the
  // stations' (17-22 Oct), while ERA5 runs 1.4-2.6 C warm on fall nights. So POWER is not cold-biased and needs no offset; an earlier
  // ERA5-matched offset (-3.3 / -2.8 C) was removed (VALIDATION.md, Round 3). The 18 Oct 1992 freeze is real (stations -4.4 and -5.6 C).
  var KILL_FALL_C = -2.0, KILL_SPRING_C = -2.0;
  var SPRING_FROST_Y = 0.93;               // SOURCED (plan): a hard freeze between emergence and V5 -> 0.93
  var FROST_C = 0;                         // a frost night: Tmin <= 0 C (flags and events; light frost has no yield effect in this model)
  var FALL_FROST_START = '07-01';          // DESIGN: frost before this date counts as spring frost
  var FALL_FROST_Y = {                     // killing frost (Tmin <= -2 C) before maturity: yield share kept.
    // corn: R4 soft dough 0.45, R5 dent 0.60, R5.5 half milk line 0.88, R6 1.0 (SOURCED: UNL CropWatch "Frost/freeze effects on corn
    // and soybean": 55%, 40%, 12% loss); 0.20 at R1 and the straight lines between stages are DESIGN. Soybean R6 0.70, R7 0.95 (SOURCED, UNL).
    corn: [[1420, 0.20], [2190, 0.45], [2450, 0.60], [2575, 0.88], [2700, 1.0]],
    soybean: [[1000, 0.30], [1700, 0.70], [2000, 0.95], [2200, 1.0]]
  };
  // Hybrid / variety matched to the location (DESIGN rule following OSU extension advice that grain corn should reach black layer one
  // to two weeks before the first killing frost): maturity GDD = the GDD reached, from the plan's target planting date, 14 days before
  // the first -2 C night in 9 of 10 past seasons of this grid cell; never longer than the reference value. Corn planted after 1 May
  // needs 6.8 fewer GDD per day of delay (SOURCED: Purdue, Nielsen, "Hybrid maturity decisions for delayed planting", ~200 GDD per month).
  var HYBRID = { killC: KILL_FALL_C, marginDays: 14, safeShare: 0.9, lateGddPerDay: 6.8, lateFrom: '05-01', target: { corn: '04-28', soybean: '05-15' } };
  var HARVEST_AFTER_MAT = 10, HARVEST_AFTER_FROST = 14;   // DESIGN: days from maturity (or killing frost) to harvest; never before the plan's target date
  var HARV_VISIBLE = 28;                   // DESIGN: days stubble is shown as 'harvested'
  var PLANT = {                            // workability (SOURCED rule from build plan; oats values DESIGN)
    corn:    { meanT: 10, last: '06-05' },
    soybean: { meanT: 10, last: '06-20' },
    oats:    { meanT: 5,  last: '05-15' }
  };
  var PLANT_RAIN2 = 5, PLANT_FROST = -2, PLANT_LATE_FLAG = 7;   // SOURCED (plan): < 5 mm rain over 2 days, Tmin > -2 C; flag when > 7 days late
  var PLANT_RUN = 2;                       // DESIGN: planting needs this many workable days in a row (seedbed and fertiliser, then the planter)
  var WET_SURPLUS = 0.05;                  // DESIGN: water above field capacity of more than 5% of TAW counts as saturated
  var REF_KDR = 0.7;                       // DESIGN: reference county soil drains as a mix of well and poorly drained soils
  var WW_DAYS_MIN = 3, WW_LOSS = 0.02, WW_MIN = 0.75;     // Yww rule (DESIGN, labelled in plan)
  var WW_FROM = '05-01', WW_TO = '06-30';
  // Corn after corn: Yrot = 1 - 0.085 x (0.6 + 0.8 x max(0, 1 - Yw)) / (0.6 + 0.8 x max(0, 1 - Yw_median)): 8.5% in the median season
  // (SOURCED: ISU budgets 193 vs 211 bu/acre), more in dry seasons (shape from the plan, DESIGN). Centring on the median season keeps the
  // sourced 8.5% for a normal year whatever the water-stress model does.
  var ROT_CC = { base: 0.085, a: 0.6, b: 0.8 };
  var ROT_SS = 0.93;                                       // soybean after soybean (DESIGN, no source)
  var PD_CORN = [['05-10', 1.00], ['05-15', 0.99], ['05-20', 0.95], ['05-30', 0.90], ['06-05', 0.80], ['06-13', 0.68], ['06-26', 0.52]];   // SOURCED: ISU 1997-2000 trials
  var PD_FLOOR = 0.30;                                     // DESIGN
  var PD_SOY = { flat: '05-10', slope1: 0.003, to1: '05-31', slope2: 0.007, to2: '06-15', slope3: 0.010 };   // DESIGN
  var PD_OATS = { flat: '04-25', slope: 0.010 };           // DESIGN
  var HEAVY_RAIN_MM = 25;                                  // heavy-rain day (SOURCED in plan)
  var EROSION_G = 0.25, EROSION_SLOPE = 2;                 // erosion flag: heavy rain on green < 0.25 with slope >= 2% (task rule)
  var HEAT_WEEK_HDD = 8;                                   // DESIGN: a week with >= 8 degree-days above the crop's critical Tmax is flagged heat
  var DROUGHT_KS = 0.85;                                   // DESIGN: weekly mean Ks below this is flagged dry soil
  // "Living roots" metric (replaces green ground cover): a day counts when a crop is alive in the field, from establishment (cash crop: emergence;
  // rye: seeding) to termination, maturity or a killing frost. NRCS soil health principle "maximize presence of living roots". Rye counts through the
  // winter (dormant, roots alive). Cash crops stop counting at maturity (the plant is dead before harvest).
  var YIELD_CAP_PCT = 125;                                 // DESIGN
  var HARV_GREEN = 0.06, BARE_GREEN = 0.04, RESIDUE_GREEN = 0.10, MULCH_G = 0.15, MULCH_DAYS = 14;   // DESIGN
  var GREEN_WATER_DAMP = 0.3;                              // green = G x (1 - 0.3 x water stress) (plan)
  var HEAT_STRESS_SPAN = 20, HEAT_STRESS_W = 0.5;          // weekly stress display: heat part = min(1, HDDweek/20) x 0.5 (DESIGN)
  var RISK_LOW = -30, RISK_HIGH = -100;                    // risk: avg of the 5 worst seasons' difference vs current plan, $/acre (DESIGN)
  var N_WORST = 5;                                         // (plan)
  var COVER_MIN_GAIN = 0.1;                                // DESIGN: months with living roots that count as "more cover" for the cover priority
  // Warming response for the temperature slider only (shift > 0). ASSUMPTION, SOURCED size: Zhao et al. 2017, PNAS 114:9326, global average yield loss per
  // degree C of warming, no CO2 fertilisation and no adaptation: maize 7.4%, soybean 3.1%. Applied per field-season as
  // ratio = min(model's own Y(shift) / Y(0), 1 - rate x shift), so replays at shift 0 and the validation are unchanged. Cooling: the model only.
  var WARM_LOSS = { corn: 0.074, soybean: 0.031 };
  // Risk numbers only: widen each season's yield deviation from the plan's median by k = sd(observed) / sd(predicted) of the leave-one-year-out
  // check in data/validation.json (about 1.7 corn, 2.2 soybean), because the model's season-to-season spread is much narrower than Iowa's.
  // CALIBRATION. Displayed yields and the average difference between plans are not widened. RISK_FLOOR keeps a widened season above 30% of the median.
  var RISK_K_DEFAULT = 1.5, RISK_FLOOR = 0.3;
  // "Too close to call" tests (a recommendation is close when its sign flips under any of these; all DESIGN ranges except where noted):
  // corn/soybean price ratio +-10%; soybean after soybean drag 3.5-10.5% (central 7%, no published source); corn after corn drag +-2 points of the sourced 8.5%;
  // rye cost +-50% (a placeholder); soybean cost +-5% (sources conflict).
  var CLOSE = { priceRatio: 0.10, ssDrag: [0.035, 0.105], ccDragPts: 0.02, ryeCost: 0.5, soyCost: 0.05 };
  var COST_SHARE_CAP_ACRES = 160;                          // SOURCED: IDALS 2026 cover crop cost-share, 160-acre cap (data.js economics)
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var STAGE_TEXT = { planted: 'planting', emerged: 'emergence', vegetative: 'leaf growth', flowering: 'flowering', grainfill: 'grain fill', mature: 'ripening' };
  var CROP_ID = { none: 0, corn: 1, soybean: 2, rye: 3, oats: 4 }, CROP_NAME = ['none', 'corn', 'soybean', 'rye', 'oats'];
  var STAGE_ID = { bare: 0, residue: 1, planted: 2, emerged: 3, vegetative: 4, flowering: 5, grainfill: 6, mature: 7, harvested: 8, cover: 9 };
  var STAGE_NAME = ['bare', 'residue', 'planted', 'emerged', 'vegetative', 'flowering', 'grainfill', 'mature', 'harvested', 'cover'];
  var F_WET = 1, F_EROSION = 2, F_DELAY = 4, F_FROST = 8;  // per-day flag bits

  // ================================================================ helpers
  function ms(iso) { var p = iso.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function isoOf(t) { return new Date(t).toISOString().slice(0, 10); }
  function idxIso(iso) { return Math.round((ms(iso) - START) / DAY); }
  // season index of a 'MM-DD' calendar date inside 2026-11-16 .. 2027-11-15
  function idxMD(md) { var m = +md.slice(0, 2); return idxIso((m >= 11 ? '2026-' : '2027-') + md); }
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function r1(x) { return Math.round(x * 10) / 10; }
  function r2(x) { return Math.round(x * 100) / 100; }
  function median(a) { var s = a.slice().sort(function (x, y) { return x - y; }), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; }
  function mean(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : 0; }
  function interp(pts, x) {
    if (x <= pts[0][0]) return pts[0][1];
    for (var i = 1; i < pts.length; i++) if (x <= pts[i][0]) { var a = pts[i - 1], b = pts[i]; return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]); }
    return pts[pts.length - 1][1];
  }
  function gddOf(tmx, tmn, base) { var g = ((Math.min(tmx * 1.8 + 32, 86) + Math.max(tmn * 1.8 + 32, base)) / 2) - base; return g > 0 ? g : 0; }
  var IDX = { wwFrom: idxMD(WW_FROM), wwTo: idxMD(WW_TO), fallFrost: idxMD(FALL_FROST_START), dec1: idxMD('12-01'), mar1: idxMD('03-01'),
              apr1: idxMD('04-01'), jun1: idxMD('06-01'), jun30: idxMD('06-30'), aug31: idxMD('08-31'), ryeSpringEnd: idxMD('07-01'),
              late: idxMD(HYBRID.lateFrom), ryeSpring: idxMD(RYE.springFrom) };
  var PD_CORN_PTS = PD_CORN.map(function (p) { return [idxMD(p[0]), p[1]]; });
  var PD_SOY_IDX = [idxMD(PD_SOY.flat), idxMD(PD_SOY.to1), idxMD(PD_SOY.to2)], PD_OATS_IDX = idxMD(PD_OATS.flat);
  function pdFor(crop, d) {
    if (crop === 'corn') {
      var last = PD_CORN_PTS[PD_CORN_PTS.length - 1], prev = PD_CORN_PTS[PD_CORN_PTS.length - 2];
      if (d > last[0]) return Math.max(PD_FLOOR, last[1] + (last[1] - prev[1]) / (last[0] - prev[0]) * (d - last[0]));
      return interp(PD_CORN_PTS, d);
    }
    if (crop === 'soybean') {
      var f = PD_SOY_IDX[0], t1 = PD_SOY_IDX[1], t2 = PD_SOY_IDX[2], y = 1;
      if (d > f) y -= PD_SOY.slope1 * (Math.min(d, t1) - f);
      if (d > t1) y -= PD_SOY.slope2 * (Math.min(d, t2) - t1);
      if (d > t2) y -= PD_SOY.slope3 * (d - t2);
      return Math.max(PD_FLOOR, y);
    }
    var fo = PD_OATS_IDX;
    return d > fo ? Math.max(PD_FLOOR, 1 - PD_OATS.slope * (d - fo)) : 1;
  }
  function drainK(soil) {
    var s = (soil && soil.drainage) || '';
    for (var i = 0; i < DRAIN_K.length; i++) if (DRAIN_K[i][0].test(s)) return DRAIN_K[i][1];
    return 1;
  }
  function wtShare(soil) {
    var s = (soil && soil.drainage) || '';
    for (var i = 0; i < WT_SHARE.length; i++) if (WT_SHARE[i][0].test(s)) return WT_SHARE[i][1];
    return WT_SHARE_WELL;
  }
  function soilOf(field, farm) {
    var s = field.soil && typeof field.soil === 'object' ? field.soil : {};
    return { awc: s.awcMmPerM || (farm && farm.countyAwcMmPerM) || 180, slope: s.slopePct == null ? 2 : s.slopePct, kdr: drainK(s), wt: wtShare(s), name: s.name || '', drainage: s.drainage || '' };
  }
  function dayDate(d) { return isoOf(START + d * DAY); }
  function dayWords(d) { var t = new Date(START + d * DAY); return t.getUTCDate() + ' ' + MONTHS_LONG[t.getUTCMonth()]; }
  function realDayWords(d, year) { return dayWords(d) + ' ' + (d < 46 ? year - 1 : year); }

  // ================================================================ weather access (decoded once per climate object and year)
  var wxCache = { clim: null, years: {} };
  function climate() { return FS.data.climate; }
  function baseWx(year) {
    var C = climate();
    if (wxCache.clim !== C) wxCache = { clim: C, years: {} };
    var w = wxCache.years[year];
    if (w) return w;
    var s = C.seasons[String(year)], sc = C.meta.scale;
    function dec(a, k) { var o = new Float64Array(N_DAYS); for (var i = 0; i < N_DAYS; i++) o[i] = a[i] / k; return o; }
    w = { year: year, tmax: dec(s.tmax, sc.tmax), tmin: dec(s.tmin, sc.tmin), rain: dec(s.rain, sc.rain), et0: dec(s.et0, sc.et0) };
    wxCache.years[year] = w;
    return w;
  }
  // Weather events (API_V3 section 2): a dry or wet month scales that calendar month's rain; a heatwave raises Tmax and Tmin on days 10-19 of the month and
  // ET0 by the same ET_PER_C per degree the temperature slider uses, applied to the mean temperature rise. Multipliers are the contract's (DESIGN); there is
  // NO heat-damage penalty: heat damage is not identifiable from the NASS data (fitted b = 0), so a heatwave acts through extra water use only.
  var EVENT_RAIN = { dryspell: { moderate: 0.3, severe: 0 }, wetspell: { moderate: 2, severe: 3 } };
  var EVENT_HEAT = { moderate: { tx: 5, tn: 2 }, severe: { tx: 8, tn: 3 } };
  var EVENT_DAYS = [10, 19], MAX_EVENTS = 3;
  var EVENT_NAMES = { dryspell: 'dry', wetspell: 'wet', heatwave: 'hot' };
  function cleanEvents(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (e) {
      if (out.length >= MAX_EVENTS || !e) return;
      var m = Math.round(+e.month), sev = e.severity === 'severe' ? 'severe' : e.severity === 'moderate' ? 'moderate' : null;
      if (EVENT_NAMES[e.type] && sev && m >= 1 && m <= 12) out.push({ type: e.type, month: m, severity: sev });
    });
    return out;
  }
  // Irrigation (API_V4 section 3): 25 mm (one inch) a week, spread evenly over the days of the chosen months, on every field and in every replayed season.
  // The water enters the daily soil-water balance next to rain (no runoff). Default 'none' adds nothing.
  var IRR_MM_WEEK = 25;                    // one inch a week (the contract's size)
  var IRR_MONTHS = { none: [], july: [7], 'july-aug': [7, 8], 'jun-aug': [6, 7, 8] };
  var IRR_WORDS = { july: 'July', 'july-aug': 'July and August', 'jun-aug': 'June to August' };
  // Cost: UNL Extension (NebGuide / Irricost) gives 37 kWh of electricity per acre-inch for a well-designed pumping plant at a 150-foot lift and 60 psi.
  // The electricity price of $0.10/kWh is a WORKING VALUE (DESIGN), not a sourced price; energy only (no equipment, labour or water-right costs).
  var IRR_KWH_PER_ACRE_IN = 37, IRR_DOLLARS_PER_KWH = 0.10, IRR_COST_PER_ACRE_IN = IRR_KWH_PER_ACRE_IN * IRR_DOLLARS_PER_KWH;
  var IRR_ARR = {};
  Object.keys(IRR_MONTHS).forEach(function (k) {
    var a = new Float64Array(N_DAYS_C);
    for (var d = 0; d < N_DAYS_C; d++) if (IRR_MONTHS[k].indexOf(CAL_M(d)) >= 0) a[d] = IRR_MM_WEEK / 7;
    IRR_ARR[k] = a;
  });
  function irrInches(mode) { var a = IRR_ARR[mode], s = 0; if (!a) return 0; for (var d = 0; d < a.length; d++) s += a[d]; return s / 25.4; }
  function irrCostPerAcre(mode) { return irrInches(mode) * IRR_COST_PER_ACRE_IN; }
  function shiftOf(wc, cc) {
    var ts = +(wc && wc.tempShift) || 0, pd = Math.round(+(cc && cc.plantShiftDays) || 0), ir = cc && IRR_MONTHS[cc.irrigation] && cc.irrigation !== 'none' ? cc.irrigation : 'none';
    return { ts: ts, rs: Math.max(0, 1 + (+(wc && wc.rainChange) || 0) / 100), ef: 1 + ET_PER_C * ts, pd: clamp(pd, -21, 21), ev: cleanEvents(wc && wc.events), irr: ir, aw: clamp(Math.round(+(cc && cc.soilWaterPct) || 0), -60, 40) };
  }
  var NO_SHIFT = { ts: 0, rs: 1, ef: 1, pd: 0, ev: [], irr: 'none', aw: 0 };
  function evKey(sh) { return sh.ev.map(function (e) { return e.type + e.month + e.severity; }).join(','); }
  function wxKey(sh) { return sh.ts + '|' + sh.rs + (sh.ev.length ? '|' + evKey(sh) : ''); }
  function shiftKey(sh) { return wxKey(sh) + (sh.pd ? '|p' + sh.pd : '') + (sh.irr && sh.irr !== 'none' ? '|i' + sh.irr : '') + (sh.aw ? '|a' + sh.aw : ''); }
  // the same weather and planting shift with the temperature and rain sliders at 0 (the unwarmed outcome the warming floor is measured against)
  function unwarmed(sh) { return sh.ts === 0 && sh.rs === 1 ? sh : { ts: 0, rs: 1, ef: 1, pd: sh.pd, ev: sh.ev, irr: sh.irr, aw: sh.aw }; }
  // calendar month and day of month of each season day (the 2026-27 calendar, 29 Feb never present)
  var CAL = (function () { var m = new Uint8Array(N_DAYS), dm = new Uint8Array(N_DAYS); for (var d = 0; d < N_DAYS; d++) { var t = new Date(START + d * DAY); m[d] = t.getUTCMonth() + 1; dm[d] = t.getUTCDate(); } return { m: m, d: dm }; })();
  // plan-independent daily quantities of one season under one weather shift (shared by every field and plan; cached)
  var dayCache = { clim: null, map: {}, n: 0 }, DAY_CACHE_MAX = 44 * 24;
  function dayWx(wx, sh) {
    var C = climate();
    if (dayCache.clim !== C) dayCache = { clim: C, map: {}, n: 0 };
    var key = wx.year + '|' + wxKey(sh), o = dayCache.map[key];
    if (o) return o;
    if (dayCache.n > DAY_CACHE_MAX) dayCache = { clim: C, map: {}, n: 0 };   // bound memory when the sliders are swept
    var n = N_DAYS, tx = new Float64Array(n), tn = new Float64Array(n), P = new Float64Array(n), et0 = new Float64Array(n), mean7 = new Float64Array(n),
        g50 = new Float64Array(n), g32 = new Float64Array(n), topWet = new Uint8Array(n), rain2 = new Uint8Array(n), De = TOP_REW, s7 = 0, d, nEv = sh.ev.length;
    for (d = 0; d < n; d++) {
      tx[d] = wx.tmax[d] + sh.ts; tn[d] = wx.tmin[d] + sh.ts; P[d] = wx.rain[d] * sh.rs; et0[d] = wx.et0[d] * sh.ef;
      for (var e = 0; e < nEv; e++) {            // weather events (API_V3 section 2), on top of the sliders
        var ev = sh.ev[e];
        if (CAL.m[d] !== ev.month) continue;
        if (ev.type === 'heatwave') {
          if (CAL.d[d] >= EVENT_DAYS[0] && CAL.d[d] <= EVENT_DAYS[1]) { var h = EVENT_HEAT[ev.severity]; tx[d] += h.tx; tn[d] += h.tn; et0[d] *= 1 + ET_PER_C * (h.tx + h.tn) / 2; }
        } else P[d] *= EVENT_RAIN[ev.type][ev.severity];
      }
      g50[d] = gddOf(tx[d], tn[d], 50); g32[d] = gddOf(tx[d], tn[d], 32);
      s7 += (tx[d] + tn[d]) / 2; if (d >= 7) s7 -= (tx[d - 7] + tn[d - 7]) / 2;
      mean7[d] = s7 / Math.min(7, d + 1);
      // topsoil (workability) layer: wetted by rain, dried by evaporation (FAO-56 ch. 7, stage 1 then stage 2)
      De -= P[d]; if (De < 0) De = 0;
      De += (De <= TOP_REW ? 1 : Math.max(0, (TOP_TEW - De) / (TOP_TEW - TOP_REW))) * et0[d];
      if (De > TOP_TEW) De = TOP_TEW;
      topWet[d] = De < TOP_REW ? 1 : 0;
      rain2[d] = P[d] + (d > 0 ? P[d - 1] : 0) >= PLANT_RAIN2 ? 1 : 0;
    }
    o = { tx: tx, tn: tn, P: P, et0: et0, mean7: mean7, g50: g50, g32: g32, topWet: topWet, rain2: rain2 };
    dayCache.map[key] = o; dayCache.n++;
    return o;
  }

  // ================================================================ scenarios (API_V2 section 1)
  var ALIAS = { wet2019: 'y2019' };        // removed id kept working for old links
  function scenario(id) {
    var list = FS.data.weatherScenarios || [], C = climate(), years = C.meta.years, i;
    id = ALIAS[id] || id;
    for (i = 0; i < list.length; i++) if (list[i].id === id) { var s = list[i]; return { id: s.id, label: s.label, phrase: s.phrase || ('the ' + s.year + ' season'), year: s.year, note: s.note || '' }; }
    var m = /^y(\d{4})$/.exec(String(id));
    if (m && years.indexOf(+m[1]) >= 0) {
      var y = +m[1], ref = getRef(FS.data.farm), k = years.indexOf(y), jja = ref.rainJJA[k], aj = ref.rainAJ[k];
      var note = 'Real ' + y + ' weather from NASA POWER: June-August rain ' + Math.round(jja) + ' mm (median ' + Math.round(ref.medRainJJA) + '), April-June rain ' + Math.round(aj) + ' mm (median ' + Math.round(ref.medRainAJ) + ').';
      return { id: 'y' + y, label: y + ' season', phrase: 'the ' + y + ' season', year: y, note: note };
    }
    return list.length ? scenario(list[0].id) : { id: 'y' + C.meta.typicalYear, label: C.meta.typicalYear + ' season', phrase: 'the ' + C.meta.typicalYear + ' season', year: C.meta.typicalYear, note: '' };
  }

  // ================================================================ plans
  var planCache = {};
  function planInfo(planId) {
    var P = FS.data.plans[planId], c = planCache[planId];
    if (c && c.src === P) return c;
    var segs = [], cash = null, rye = null;
    P.sequence.forEach(function (s) {
      if (s.crop === 'none') return;
      var o = { crop: s.crop, from: Math.max(0, idxIso(s.from)), rye: s.crop === 'rye', fromRaw: idxIso(s.from) };
      if (o.rye) { o.end = idxIso(s.end); if (!rye) rye = o; }
      else { o.harvest = idxIso(s.harvest); o.last = Math.max(o.from, idxMD(PLANT[s.crop].last)); if (!cash) cash = o; }
      segs.push(o);
    });
    segs.sort(function (a, b) { return a.from - b.from; });
    c = { src: P, id: planId, label: P.label, segs: segs, cashCrop: cash ? cash.crop : 'none', hasRye: !!rye };
    planCache[planId] = c;
    return c;
  }

  // Planting shift (API_V3 section 1): every cash crop's target planting date, its target harvest date and the end of a cover crop that is terminated
  // for it move by pd days. The wet-soil planting rule, GDD stages, frost checks and the sourced planting-date curves then do the rest; the hybrid
  // stays the one matched to the usual dates. A cover crop seeded after oats keeps its dates. No new numbers.
  var shiftedCache = {};
  function planShifted(plan, pd) {
    if (!pd) return plan;
    var key = plan.id + '|' + pd, c = shiftedCache[key];
    if (c && c.src === plan.src) return c;
    var segs = plan.segs.map(function (g, i) {
      var o = {}, k; for (k in g) o[k] = g[k];
      if (!g.rye) { o.fromRaw = g.fromRaw + pd; o.from = Math.max(0, g.from + pd); o.harvest = g.harvest + pd; o.last = Math.max(o.from, g.last); }
      else if (g.from === 0 && plan.segs[i + 1] && !plan.segs[i + 1].rye) o.end = Math.max(g.from, g.end + pd);   // rye killed for the cash crop that follows
      return o;
    });
    c = { src: plan.src, id: plan.id, label: plan.label, segs: segs, cashCrop: plan.cashCrop, hasRye: plan.hasRye };
    shiftedCache[key] = c;
    return c;
  }

  // ================================================================ hybrid / variety matched to the location (cached per climate)
  var hybCache = { clim: null, val: null };
  function hybrids() {
    var C = climate();
    if (hybCache.clim === C) return hybCache.val;
    var out = {};
    ['corn', 'soybean'].forEach(function (crop) {
      var base = CROPS[crop], t0 = idxMD(HYBRID.target[crop]), avail = [];
      C.meta.years.forEach(function (y) {
        var w = baseWx(y), kill = N_DAYS - 1, d, g = 0;
        for (d = IDX.fallFrost; d < N_DAYS; d++) if (w.tmin[d] <= HYBRID.killC) { kill = d; break; }
        for (d = t0; d <= kill - HYBRID.marginDays; d++) g += gddOf(w.tmax[d], w.tmin[d], base.base);
        avail.push(g);
      });
      avail.sort(function (a, b) { return a - b; });
      var q = avail[Math.max(0, Math.floor((1 - HYBRID.safeShare) * avail.length))];
      out[crop] = Math.min(base.mat, Math.round(q / 10) * 10);
    });
    hybCache = { clim: C, val: out };
    return out;
  }
  // thresholds of the crop actually planted (scaled to the matched maturity, corn shortened for late planting)
  function cropFor(crop, plantDay) {
    var b = CROPS[crop], mat = b.mat;
    if (crop === 'corn' || crop === 'soybean') mat = hybrids()[crop];
    if (crop === 'corn' && plantDay > IDX.late) mat -= HYBRID.lateGddPerDay * (plantDay - IDX.late);
    var k = mat / b.mat, o = {};
    for (var key in b) o[key] = b[key];
    ['gV', 'gR1', 'flowS', 'flowE', 'ripeS', 'senS', 'gMid', 'gSlope'].forEach(function (kk) { o[kk] = b[kk] * k; });
    o.mat = mat; o.k = k;
    o.zMax = crop === 'oats' ? b.zMax : Math.min(PROFILE_Z, FIT.zMaxCorn * b.root);
    o.frost = FALL_FROST_Y[crop] ? FALL_FROST_Y[crop].map(function (p) { return [p[0] * k, p[1]]; }) : null;
    o.heatB = (FIT[crop] || FIT.corn).heatB;
    return o;
  }

  // ================================================================ the daily model for one field, one plan, one weather series
  // ctx: { awc, slope, kdr, prev (last crop), detail, start: { fr, fs } }
  var FIXED_START = { fr: START_DEPLETION, fs: START_DEPLETION };
  function sim(plan, wx, sh, ctx, heat) {
    var segs = plan.segs, nseg = segs.length, sp = 0;
    var awc = ctx.awc, kdr = ctx.kdr, crMax = FIT.crMax * (ctx.wt == null ? WT_SHARE_REF : ctx.wt), rf = ctx.slope >= STEEP_SLOPE ? RUNOFF_STEEP : RUNOFF_FLAT, detail = !!ctx.detail;
    var dw = dayWx(wx, sh), txA = dw.tx, tnA = dw.tn, PA = dw.P, etA = dw.et0, irA = sh.irr && sh.irr !== 'none' ? IRR_ARR[sh.irr] : null;
    var st0 = ctx.start || FIXED_START;
    var zr = (nseg && segs[0].rye && segs[0].from === 0) ? RYE.zr : FALLOW_ZR;
    var Dr = st0.fr * awc * zr, Ds = st0.fs * awc * (PROFILE_Z - zr), streak = 0;
    var D;
    if (detail) D = { crop: new Uint8Array(N_DAYS), stage: new Uint8Array(N_DAYS), G: new Float32Array(N_DAYS), sw: new Float32Array(N_DAYS), ks: new Float32Array(N_DAYS),
                      grow: new Uint8Array(N_DAYS), flags: new Uint8Array(N_DAYS), hdd: new Float32Array(N_DAYS), def: new Float32Array(N_DAYS), cat: new Int8Array(N_DAYS),
                      lossF: new Float32Array(N_DAYS), lossWW: new Float32Array(N_DAYS) };
    var rootDays = 0;
    var ryeFall = 0, ryeSpring = 0, ryeKill = -999, ryeBio = 0, ryeUsed = false, ryeKillBeforePlant = null;
    var cp = null, planted = false, plantDay = -1, gdd = 0, mature = false, matDay = -1, killed = false, killDay = -1, springHit = false;
    var yf = 1, yfs = 1, hdd = 0, wwDays = 0, waitWet = 0, waitCold = 0, fillG = 0, fillD = 0, unfinished = false, workRun = 0;
    var etc = [0, 0, 0, 0], eta = [0, 0, 0, 0], lastEnd = null;
    var frostSpring = null, frostFall = null;
    var crop0 = null;
    var tcrit = 0;

    for (var d = 0; d < N_DAYS; d++) {
      var tmx = txA[d], tmn = tnA[d], P = PA[d], et0 = etA[d], tmean = (tmx + tmn) / 2;
      var seg = null, kind = 0, fdayAll = 0, frostDay = false;
      while (sp < nseg) {
        seg = segs[sp];
        if (seg.rye && d > seg.end) {
          ryeBio = ryeUsed ? Math.min(RYE.bioMax, Math.min(RYE.bioFallMax, RYE.bioFall * ryeFall) * RYE.bioFallCarry + RYE.bioSpring * ryeSpring) : 0;
          ryeKill = seg.end; lastEnd = { kind: 'rye', d: seg.end }; sp++; seg = null; continue;
        }
        break;
      }
      seg = sp < nseg ? segs[sp] : null;
      var G = 0, stage = 1, cropName = 'none', zn = FALLOW_ZR, kcMid = 1, ptab = 0.55, growing = 0, delayed = false, alive = 0;

      if (seg && seg.rye) {
        if (d >= seg.from) {
          kind = 1; ryeUsed = true;
          if (d === seg.from && seg.fromRaw < 0) ryeFall = RYE.fall0;
        }
      } else if (seg) {
        if (!planted && d >= seg.from) {
          var ok = d >= seg.last, cold = false, wet = false;
          if (!ok) {
            cold = dw.mean7[d] < PLANT[seg.crop].meanT || tmn <= PLANT_FROST;
            wet = dw.rain2[d] === 1 || dw.topWet[d] === 1 || Dr < -WET_SURPLUS * awc * zr;
            workRun = cold || wet ? 0 : workRun + 1;
            ok = workRun >= PLANT_RUN;
            if (!ok) { if (wet) waitWet++; else if (cold) waitCold++; }
          }
          if (ok) {
            planted = true; plantDay = d; gdd = 0; cp = cropFor(seg.crop, d); mature = false; killed = false; springHit = false;
            yf = 1; yfs = 1; hdd = 0; wwDays = 0; etc = [0, 0, 0, 0]; eta = [0, 0, 0, 0]; fillG = 0; fillD = 0;
            tcrit = heat[cp.tcrit];
            ryeKillBeforePlant = ryeUsed && ryeKill > -999 ? d - ryeKill : null;
          }
        }
        if (planted) kind = 2;
      }

      var Gkind = 0;
      if (kind === 2) {
        cropName = seg.crop;
        var gd = cp.base === 32 ? dw.g32[d] : dw.g50[d];
        if (!killed) gdd += gd;
        var fday = 0;
        if (!killed && mature && tmn <= FROST_C && d >= IDX.fallFrost && !frostFall) {
          frostDay = true;
          frostFall = { d: d, tmin: tmn, gdd: gdd, gE: cp.gE, gV: cp.gV, gR1: cp.gR1, mat: cp.mat, killing: tmn <= KILL_FALL_C, crop: seg.crop, loss: 0, mature: true };
        }
        if (!killed && !mature) {
          if (tmn <= FROST_C) {
            frostDay = true;
            var spr = d < IDX.fallFrost, fr = { d: d, tmin: tmn, gdd: gdd, gE: cp.gE, gV: cp.gV, gR1: cp.gR1, mat: cp.mat, killing: tmn <= (spr ? KILL_SPRING_C : KILL_FALL_C), crop: seg.crop, loss: 0 };
            if (spr) { if (!frostSpring || !frostSpring.killing || fr.killing) frostSpring = fr; } else if (!frostFall || (!frostFall.killing && fr.killing)) frostFall = fr;
          }
          if (gdd >= cp.gE) {
            if (d < IDX.fallFrost) {
              if (tmn <= KILL_SPRING_C && !springHit && gdd < cp.gV) { springHit = true; yfs = SPRING_FROST_Y; fday = 1 - SPRING_FROST_Y; frostSpring.loss = fday; }
            } else if (tmn <= KILL_FALL_C && cp.frost) {
              killed = true; killDay = d; yf = interp(cp.frost, gdd); fday = 1 - yf; frostFall.loss = fday;
            }
          }
        }
        if (!mature && !killed && gdd >= cp.mat) { mature = true; matDay = d; }
        var done = mature || killed;
        if (gdd < cp.gE) stage = 2; else if (gdd < cp.gV) stage = 3; else if (gdd < cp.flowS) stage = 4; else if (gdd < cp.flowE) stage = 5; else if (!done) stage = 6; else stage = 7;
        if (done) stage = 7;
        var cat = gdd < cp.flowS ? 0 : gdd < cp.flowE ? 1 : gdd < cp.ripeS ? 2 : 3;
        if (!done && gdd >= cp.gR1) { fillG += gd; fillD++; }
        var gcur = cp.gPeak / (1 + Math.exp(-(gdd - cp.gMid) / cp.gSlope));
        if (gdd < cp.gE) gcur = 0.03;
        if (gdd > cp.senS) gcur *= Math.max(0.1, 1 - (gdd - cp.senS) / (cp.mat - cp.senS));
        if (killed) gcur *= Math.max(0.15, 1 - (d - killDay) / 10);
        G = gcur; kcMid = cp.kcMid; ptab = cp.pTab;
        zn = 0.2 + (cp.zMax - 0.2) * Math.min(1, Math.max(0, gdd - cp.gE) / cp.gR1);
        growing = (!done) ? 1 : 0;
        alive = (!done && gdd >= cp.gE) ? 1 : 0;
        if (plantDay - seg.from > PLANT_LATE_FLAG && stage <= 3) delayed = true;
        Gkind = cat; fdayAll = fday;
        if (detail) { D.lossF[d] = fday; D.cat[d] = cat; }
      } else if (kind === 1) {
        stage = 9; cropName = 'rye'; kcMid = RYE.kcMid; ptab = RYE.pTab; zn = RYE.zr; growing = 1; alive = 1;
        if (tmean > 0) { if (d < IDX.ryeSpringEnd && d >= IDX.ryeSpring) ryeSpring += tmean; else ryeFall += tmean; }
        var gf = RYE.gFallMax * (1 - Math.exp(-ryeFall / RYE.gFallTau));
        if (d >= IDX.dec1 && d < IDX.mar1) G = RYE.gWinter + (gf - RYE.gWinter) * Math.max(0, 1 - (d - IDX.dec1) / 30);
        else if (d >= IDX.mar1 && d < IDX.ryeSpringEnd) G = RYE.gWinter + (RYE.gSpringMax - RYE.gWinter) * Math.min(1, ryeSpring / RYE.gSpringGdd);
        else G = gf;
        if (d >= IDX.dec1 && d < IDX.mar1 && gf < RYE.gWinter) G = gf + (RYE.gWinter - gf) * Math.min(1, (d - IDX.dec1) / 30);
      } else {
        var waiting = seg && !seg.rye && d >= seg.from;
        if (lastEnd && lastEnd.kind === 'harvest' && d - lastEnd.d < HARV_VISIBLE) { stage = 8; cropName = lastEnd.crop; G = HARV_GREEN; }
        else if (seg && !seg.rye && (waiting || seg.from - d <= 7)) { stage = 0; G = BARE_GREEN; }
        else { stage = 1; G = RESIDUE_GREEN; }
        if (lastEnd && lastEnd.kind === 'rye' && d - lastEnd.d <= MULCH_DAYS) G = Math.max(G, RESIDUE_GREEN + (MULCH_G) * (1 - (d - lastEnd.d) / MULCH_DAYS));
        if (waiting && seg && d - seg.from > PLANT_LATE_FLAG) delayed = true;
      }

      // ---- root zone grows into (or gives back) the soil below: water moves with the soil slice
      if (zn > PROFILE_Z) zn = PROFILE_Z;
      if (zn > zr + 1e-9) { var zs = PROFILE_Z - zr, mv = zs > 1e-6 ? Ds / zs * (zn - zr) : 0; Dr += mv; Ds -= mv; }
      else if (zn < zr - 1e-9) { var mv2 = (Dr > 0 ? Dr : 0) / zr * (zr - zn); Dr -= mv2; Ds += mv2; }
      zr = zn;

      // ---- soil-water bucket (FAO-56 ch. 8); surplus above field capacity drains into the soil below the roots
      var Kc = KC_MIN + (kcMid - KC_MIN) * G;
      var ETc = Kc * et0;
      var TAW = awc * zr;
      var p = clamp(ptab + P_ADJ * (5 - ETc), 0.1, 0.8), RAW = p * TAW;
      var Ks = Dr <= RAW ? 1 : clamp((TAW - Dr) / ((1 - p) * TAW), 0, 1);
      var ETa = Ks * ETc, RO = P > RUNOFF_P0 ? rf * (P - RUNOFF_P0) : 0;
      var CR = zr >= WT_ROOT_Z && Dr > 0 ? crMax * Dr / TAW : 0;
      Dr = Dr - (P - RO) - CR + ETa;
      if (irA) Dr -= irA[d];                              // irrigation water (API_V4 section 3)
      if (Dr > TAW) Dr = TAW;
      if (Dr < 0) {
        var sur = -Dr, drained = sur * kdr; sur -= drained;
        Ds -= drained; if (Ds < 0) Ds = 0;                // the soil below refills; the rest leaves through drains and deep percolation
        var cap = SURPLUS_CAP * TAW; if (sur > cap) sur = cap; Dr = -sur;
      }
      var sw = clamp(1 - Dr / TAW, 0, 1);
      if (Dr < -WET_SURPLUS * TAW) streak++; else streak = 0;
      if (alive) rootDays++;

      // ---- yield accumulators (cash crop, emergence .. maturity)
      var hddDay = 0;
      if (kind === 2 && gdd >= cp.gE && !(mature && d > matDay) && !(killed && d > killDay)) {
        etc[Gkind] += ETc; eta[Gkind] += ETa;
        hddDay = tmx > tcrit ? tmx - tcrit : 0; hdd += hddDay;
      }
      var wwDay = 0;
      if (kind === 2 && streak >= WW_DAYS_MIN && d >= IDX.wwFrom && d <= IDX.wwTo) { wwDays++; wwDay = WW_LOSS; }

      if (detail) {
        D.crop[d] = CROP_ID[cropName] || 0; D.stage[d] = stage; D.G[d] = G; D.sw[d] = sw; D.ks[d] = Ks; D.grow[d] = growing; D.hdd[d] = hddDay;
        if (kind === 2) D.def[d] = cp.ky[Gkind] * (ETc - ETa);
        var fl = 0;
        if (kind === 1 || kind === 2 || (seg && !seg.rye && d >= seg.from)) { if (streak >= WW_DAYS_MIN) fl |= F_WET; }
        if (P >= HEAVY_RAIN_MM && G < EROSION_G && ctx.slope >= EROSION_SLOPE) fl |= F_EROSION;
        if (delayed) fl |= F_DELAY;
        if (frostDay || fdayAll > 0) fl |= F_FROST;
        D.flags[d] = fl; D.lossWW[d] = wwDay;
      }

      // ---- harvest (or the end of the page timeline)
      if (kind === 2) {
        var target = seg.harvest, ready = false;
        if (killed) ready = d >= killDay + HARVEST_AFTER_FROST;
        else if (mature) ready = d >= Math.max(target, matDay + HARVEST_AFTER_MAT);
        if (ready || d === N_DAYS - 1) {
          if (!ready && !mature && !killed && cp.frost) { yf = interp(cp.frost, gdd); unfinished = true; }   // still immature on 15 Nov
          var res = finalise(cp, seg.crop, ctx, plantDay, d, etc, eta, hdd, yf, yfs, wwDays, ryeBio, ryeKillBeforePlant, ryeUsed, fillG, fillD);
          res.harvested = ready; res.late = Math.max(0, plantDay - seg.from); res.targetPlant = seg.from; res.waitWet = waitWet; res.waitCold = waitCold;
          res.killed = killed; res.killDay = killDay; res.matDay = matDay; res.gddEnd = gdd; res.unfinished = unfinished;
          res.frostSpring = frostSpring; res.frostFall = frostFall; res.matGdd = cp.mat;
          if (!crop0) crop0 = res;
          if (ready) { lastEnd = { kind: 'harvest', d: d, crop: seg.crop }; sp++; planted = false; cp = null; }
        }
      }
    }
    if (!crop0) crop0 = { Yw: 1, Yh: 1, Yww: 1, PD: 1, Yf: 1, Yrot: 1, Ycc: 1, fill: null, hdd: 0, crop: 'none', plantDay: -1, harvestDay: -1, late: 0, waitWet: 0, waitCold: 0 };
    crop0.rootDays = rootDays;
    crop0.D = D;
    crop0.end = { fr: clamp(Dr / (awc * zr), -SURPLUS_CAP, 1), fs: PROFILE_Z - zr > 1e-6 ? clamp(Ds / (awc * (PROFILE_Z - zr)), 0, 1) : 0 };
    return crop0;
  }

  function finalise(cp, crop, ctx, plantDay, d, etc, eta, hdd, yf, yfs, wwDays, ryeBio, ryeKillBefore, ryeUsed, fillG, fillD) {
    var Yw = 1, c;
    for (c = 0; c < 4; c++) if (etc[c] > 0) Yw *= Math.max(YW_STAGE_FLOOR, 1 - cp.ky[c] * (1 - eta[c] / etc[c]));
    Yw = Math.max(YW_FLOOR, Yw);
    var Yh = Math.exp(-cp.heatB * hdd), PD = pdFor(crop, plantDay), Yf = yf * yfs;
    var Yww = Math.max(WW_MIN, 1 - WW_LOSS * wwDays), Yrot = 1, Ycc = 1;
    var rotCC = crop === 'corn' && ctx.prev === 'corn';
    if (rotCC) Yrot = 1 - ROT_CC.base * (ROT_CC.a + ROT_CC.b * Math.max(0, 1 - Yw)) / ROT_CC.a;     // recentred in rawPct
    else if (crop === 'soybean' && ctx.prev === 'soybean') Yrot = ROT_SS;
    if (ryeUsed && ryeKillBefore != null) {
      if (crop === 'corn') Ycc = 1 - RYE.ccCorn * (ryeKillBefore < RYE.ccShortDays ? RYE.kShort : RYE.kLong) * (ryeBio / RYE.ccCornRef);
      else if (crop === 'soybean') Ycc = RYE.ccSoy;
    }
    // grain-fill length in days at this season's own rate of development (so a frost kill does not count twice)
    var fill = fillD >= 3 && fillG > 0 ? (cp.mat - cp.gR1) / (fillG / fillD) : null;
    return { Yw: Yw, Yh: Yh, Yww: Yww, PD: PD, Yf: Yf, Yrot: Yrot, Ycc: Ycc, rotCC: rotCC, fill: fill, crop: crop, plantDay: plantDay, harvestDay: d,
             etc: etc.slice(), eta: eta.slice(), hdd: hdd, wwDays: wwDays, ryeBio: ryeBio };
  }

  // ================================================================ season starts: soil water carried over from the season before
  // Chain over the real seasons on the county reference soil: season Y starts from the end of season Y-1 grown with the field's
  // last crop (which itself started from season Y-2 with the other crop). Cached per weather shift.
  var chainCache = {};
  function refPlanFor(crop) {
    var init = FS.data.initialControls.crops.plans, fields = FS.data.farm.fields, k;
    for (var i = 0; i < fields.length; i++) { k = init[fields[i].id]; if (k && planInfo(k).cashCrop === crop && !planInfo(k).hasRye) return k; }
    return crop === 'corn' ? 'corn' : 'soy';
  }
  function refCtx(prev, start) { var cty = (FS.data.farm && FS.data.farm.countyAwcMmPerM) || 180; return { awc: cty, slope: 2, kdr: REF_KDR, wt: WT_SHARE_REF, prev: prev, detail: false, start: start }; }
  function chain(sh) {
    var C = climate(), key = shiftKey(sh) + '|' + fitKey(), c = chainCache[key];
    if (c && c.clim === C) return c;
    var heat = heatOf(), years = C.meta.years, out = { clim: C, start: { corn: {}, soybean: {} }, res: { corn: {}, soybean: {} } };
    var other = { corn: 'soybean', soybean: 'corn' };
    years.forEach(function (y, i) {
      ['corn', 'soybean'].forEach(function (crop) {
        // start of season y for a field whose last crop was `crop`: the end of season y-1 growing `crop`
        var prevYear = years[i - 1];
        out.start[crop][y] = (FIT.startMode === 'spinup' && prevYear === y - 1) ? out.res[crop][prevYear].end : FIXED_START;
      });
      ['corn', 'soybean'].forEach(function (crop) {
        // season y growing `crop` after `other[crop]`
        out.res[crop][y] = sim(planShifted(planInfo(refPlanFor(crop)), sh.pd), baseWx(y), sh, refCtx(other[crop], out.start[other[crop]][y]), heat);
      });
    });
    chainCache[key] = out;
    return out;
  }
  function startFor(year, prevCrop, sh) {
    if (FIT.startMode !== 'spinup') return FIXED_START;
    var ch = chain(sh), s = ch.start[prevCrop === 'soybean' ? 'soybean' : 'corn'][year];
    return s || FIXED_START;
  }

  // ================================================================ normalisation (cached)
  var refCache = null;
  function heatOf() { var h = climate().meta.heatMatch; return { c29: h.c29, c30: h.c30, c35: h.c35 }; }
  var fitVersion = 1;
  function fitKey() { return fitVersion; }
  function weatherPart(res) { return Math.max(1e-6, res.Yw * res.Yh * res.Yww); }
  function mgmtPart(res) { return res.PD * res.Yf * res.Yrot * res.Ycc; }
  var REF_LOCK = null;   // set only inside outlook(): the normal stays the one measured on the farm's own past seasons
  function getRef(farm) {
    if (REF_LOCK) return REF_LOCK;
    var C = climate(), county = (farm && farm.countyAwcMmPerM) || 180, fk = fitKey();
    if (refCache && refCache.clim === C && refCache.county === county && refCache.fit === fk) return refCache;
    var t0 = Date.now(), years = C.meta.years, ch = chain(NO_SHIFT);
    var out = { clim: C, county: county, fit: fk, years: years, comp: { corn: [], soybean: [] }, medSw: {}, medFill: {}, norm: {}, pct: { corn: [], soybean: [] },
                rainJJA: [], rainAJ: [], hybrid: hybrids() };
    ['corn', 'soybean'].forEach(function (crop) {
      var rs = years.map(function (y) { return ch.res[crop][y]; });
      out.comp[crop] = rs;
      if (crop === 'corn') out.ywMed = median(rs.map(function (r) { return r.Yw; }));
      out.medSw[crop] = median(rs.map(weatherPart));
      var fills = rs.map(function (r) { return r.fill; }).filter(function (x) { return x != null; });
      out.medFill[crop] = fills.length ? median(fills) : 1;
      out.norm[crop] = 1;
      var raw = rs.map(function (r) { return rawPct(out, crop, r); });
      out.norm[crop] = median(raw) / 100;
      out.pct[crop] = rs.map(function (r) { return rawPct(out, crop, r); });
    });
    // oats: its own normal under the typical weather (DESIGN); placeholder economics anyway
    var oatsPlan = null;
    Object.keys(FS.data.plans).forEach(function (k) { if (!oatsPlan && planInfo(k).cashCrop === 'oats') oatsPlan = planInfo(k); });
    var ro = oatsPlan ? sim(oatsPlan, baseWx(typicalYear()), NO_SHIFT, refCtx('corn', null), heatOf()) : null;
    out.oatsRef = ro ? weatherPart(ro) * ro.PD * ro.Yf : 1;
    years.forEach(function (y) {
      var w = baseWx(y), s = 0, a = 0, d;
      for (d = IDX.jun1; d <= IDX.aug31; d++) s += w.rain[d];
      for (d = IDX.apr1; d <= IDX.jun30; d++) a += w.rain[d];
      out.rainJJA.push(s); out.rainAJ.push(a);
    });
    out.medRainJJA = median(out.rainJJA); out.medRainAJ = median(out.rainAJ);
    out.buildMs = Date.now() - t0;
    refCache = out;
    return out;
  }
  // yield % of normal for one result: compressed weather part x grain-fill factor x uncompressed sourced multipliers
  function rawPct(ref, crop, res) {
    if (crop === 'oats') return clamp(100 * weatherPart(res) * res.PD * res.Yf / (ref.oatsRef || 1), 0, YIELD_CAP_PCT);
    if (res.rotCC) res.Yrot = 1 - ROT_CC.base * (ROT_CC.a + ROT_CC.b * Math.max(0, 1 - res.Yw)) / (ROT_CC.a + ROT_CC.b * Math.max(0, 1 - ref.ywMed));
    var f = FIT[crop] || FIT.corn, sw = Math.pow(weatherPart(res) / ref.medSw[crop], f.gamma);
    var fl = res.fill != null && ref.medFill[crop] ? Math.pow(res.fill / ref.medFill[crop], f.eDur) : 1;
    return clamp(100 * sw * fl * mgmtPart(res) / ref.norm[crop], 0, YIELD_CAP_PCT);
  }
  function typicalYear() { var s = (FS.data.weatherScenarios || []).filter(function (x) { return x.id === 'typical'; })[0]; return s && s.year ? s.year : climate().meta.typicalYear; }

  // ================================================================ money (Step 3)
  // shareFrac: share of this field's rye acres that receive cost-share (the 160-acre cap is applied across the farm)
  function money(E, other, crop, prev, bu, hasRye, shareFrac) {
    other = other || {};
    var priceBase = E.price[crop] || 0, contracted = clamp((other.contracted == null ? 0 : other.contracted), 0, 100);
    var priceEff = priceBase * (1 + (other.priceChange || 0) / 100 * (1 - contracted / 100));
    var rev = bu * priceEff, cost = 0;
    if (crop === 'corn') {
      var after = prev === 'corn';
      cost = after ? E.costPerAcre.cornAfterCorn : E.costPerAcre.corn;
      var N = E.nitrogen || {}, lb = after ? N.lbPerAcreCornAfterCorn : N.lbPerAcreCornAfterSoy;
      cost += (lb || 0) * (N.dollarsPerLb || 0) * (other.nitrogenChange || 0) / 100;
    } else if (crop === 'soybean') cost = E.costPerAcre.soybean;
    else if (crop === 'oats') cost = E.costPerAcre.oats;
    if (other.irrCost && crop !== 'none') cost += other.irrCost;     // irrigation pumping energy (API_V4 section 3)
    if (hasRye) cost += E.costPerAcre.rye - (csOn(other) ? (E.costShareRye || 0) * (shareFrac == null ? 1 : shareFrac) : 0);
    return { rev: rev, cost: cost, ret: rev - cost };
  }
  // the controls' other-block plus the irrigation pumping cost per acre for this run (a copy only when irrigating, so defaults are untouched)
  function otherOf(controls) {
    var o = (controls && controls.other) || {}, ir = controls && controls.crops && controls.crops.irrigation;
    if (!ir || ir === 'none' || !IRR_MONTHS[ir]) return o;
    var c = {}, k; for (k in o) c[k] = o[k]; c.irrCost = irrCostPerAcre(ir); return c;
  }
  // the cover-crop cost-share is an Iowa programme (IDALS): it is only counted for Iowa farms
  function csOn(o) { return !!(o && o.costShare) && (!SITE || !SITE.state || SITE.state === 'IA'); }
  function capAcres() { var E = FS.data.economics || {}; return E.costShareCapAcres || COST_SHARE_CAP_ACRES; }

  // warming floor: yield may not fall by less than the published average (WARM_LOSS) per degree of warming
  function warmFloor(crop, pct, pct0, ts) {
    var rate = WARM_LOSS[crop];
    if (!(ts > 0) || !rate || !(pct0 > 0)) return pct;
    return pct0 * Math.min(pct / pct0, Math.max(0, 1 - rate * ts));
  }
  // evaluate one field/plan on one weather series -> { pct, bu, ret, res }
  // pct0: the same field-season's yield % at shift 0 (the warming floor needs it; computed here when the caller does not have it)
  function evalField(farm, field, planId, wx, sh, other, ref, detail, heat, shareFrac, pct0) {
    var plan = planInfo(planId), so = soilOf(field, farm), splan = planShifted(plan, sh.pd);
    if (sh.aw) so = { awc: so.awc * (1 + sh.aw / 100), slope: so.slope, kdr: so.kdr, wt: so.wt };   // chat what-if: soil holds more or less water than the survey says
    var res = sim(splan, wx, sh, { awc: so.awc, slope: so.slope, kdr: so.kdr, wt: so.wt, prev: field.lastCrop, detail: detail, start: startFor(wx.year, field.lastCrop, sh) }, heat);
    var E = FS.data.economics, crop = plan.cashCrop, pct = crop === 'none' ? 0 : rawPct(ref, crop, res);
    if (sh.ts > 0 && WARM_LOSS[crop]) {
      if (pct0 == null) {
        var sh0 = unwarmed(sh), r0 = sim(splan, wx, sh0, { awc: so.awc, slope: so.slope, kdr: so.kdr, wt: so.wt, prev: field.lastCrop, detail: false, start: startFor(wx.year, field.lastCrop, sh0) }, heat);
        pct0 = rawPct(ref, crop, r0);
      }
      pct = warmFloor(crop, pct, pct0, sh.ts);
    }
    var bu = (E.normalYield[crop] || 0) * pct / 100, m = money(E, other, crop, field.lastCrop, bu, plan.hasRye, shareFrac);
    return { plan: plan, res: res, crop: crop, pct: pct, bu: bu, m: m, ret: m.ret, soil: so };
  }

  // ================================================================ tooling hooks (tools/validate_model.js)
  function setParams(p) {
    if (!p) return JSON.parse(JSON.stringify(FIT));
    ['corn', 'soybean'].forEach(function (c) { if (p[c]) for (var k in p[c]) FIT[c][k] = p[c][k]; });
    if (p.zMaxCorn != null) FIT.zMaxCorn = p.zMaxCorn;
    if (p.startMode) FIT.startMode = p.startMode;
    if (p.crMax != null) FIT.crMax = p.crMax;
    fitVersion++; refCache = null; chainCache = {}; yieldCache = {};
    return JSON.parse(JSON.stringify(FIT));
  }
  // raw components of the reference rotation (county soil) for every season, unshifted unless sh is given
  function components(sh) {
    var C = climate(), ch = chain(sh ? shiftOf(sh, sh) : NO_SHIFT), out = { years: C.meta.years, hybrid: hybrids(), corn: [], soybean: [] };
    ['corn', 'soybean'].forEach(function (crop) {
      out[crop] = C.meta.years.map(function (y) {
        var r = ch.res[crop][y];
        return { year: y, Yw: r.Yw, Yh: r.Yh, Yww: r.Yww, hdd: r.hdd, PD: r.PD, Yf: r.Yf, fill: r.fill, plantDay: r.plantDay, late: r.late,
                 matDay: r.matDay, killDay: r.killed ? r.killDay : -1, waitWet: r.waitWet, waitCold: r.waitCold, startFr: (ch.start[crop === 'corn' ? 'soybean' : 'corn'][y] || {}).fr };
      });
    });
    return out;
  }

  // ================================================================ weekly assembly and events
  function fmtLabel(t) { var d = new Date(t); return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate(); }
  function weekOf(d) { return Math.min(N_WEEKS - 1, Math.floor(d / 7)); }

  function weeklyField(ev, field, heat) {
    var res = ev.res, D = res.D, out = [], worst = { w: -1, v: 0, cause: '' };
    var etcTot = res.etc || [0, 0, 0, 0], cp = CROPS[ev.crop], b = cp ? (FIT[ev.crop] || FIT.corn).heatB : 0;
    var wk = [];
    for (var w = 0; w < N_WEEKS; w++) {
      var a = w * 7, z = Math.min(N_DAYS - 1, a + 6), rep = Math.min(N_DAYS - 1, a + 3), nG = 0, sKs = 0, sSw = 0, sHdd = 0, fl = 0, n = z - a + 1;
      var lw = 0, lh = 0, lf = 0, lww = 0;
      for (var d = a; d <= z; d++) {
        sSw += D.sw[d]; if (D.grow[d]) { nG++; sKs += 1 - D.ks[d]; }
        sHdd += D.hdd[d]; fl |= D.flags[d];
        if (D.def[d] > 0 && etcTot[D.cat[d]] > 0) lw += D.def[d] / etcTot[D.cat[d]];
        lh += b * D.hdd[d]; lf += D.lossF[d]; lww += D.lossWW[d];
      }
      var water = nG ? sKs / nG : 0, heatPart = Math.min(1, sHdd / HEAT_STRESS_SPAN) * HEAT_STRESS_W;
      var stress = 1 - (1 - water) * (1 - (nG ? heatPart : 0));
      if (lf > 0) stress = Math.max(stress, 0.5);
      var flags = [], st = D.stage[rep];
      if (nG && sHdd >= HEAT_WEEK_HDD && ev.crop !== 'none' && D.crop[rep] === CROP_ID[ev.crop]) flags.push('heat');
      if (nG && 1 - water < DROUGHT_KS) flags.push('drought');
      if (fl & F_FROST) flags.push('frost');
      if (fl & F_WET) flags.push('waterlogged');
      if (fl & F_EROSION) flags.push('erosion');
      if (fl & F_DELAY) flags.push('planting-delay');
      var G = D.G[rep] * (1 - GREEN_WATER_DAMP * Math.min(1, water));
      out.push({ crop: CROP_NAME[D.crop[rep]], stage: STAGE_NAME[st], green: r2(clamp(G, 0, 1)), soilWater: r2(clamp(sSw / n, 0, 1)), stress: r2(clamp(stress, 0, 1)), flags: flags });
      var tot = lw + lh + lf + lww;
      wk.push({ lw: lw, lh: lh, lf: lf, lww: lww, tot: tot, hdd: sHdd, water: water });
      if (tot > worst.v) { worst.v = tot; worst.w = w; worst.cause = lf >= lw && lf >= lh && lf >= lww ? 'frost' : lh >= lw && lh >= lww ? 'heat' : lw >= lww ? 'drought' : 'wet'; }
    }
    return { weeks: out, wk: wk, worst: worst };
  }

  // plain words for the crop's stage on a frost night
  function frostStageWords(fr) {
    var c = fr.crop, g = fr.gdd;
    if (fr.mature) return c + ' was already mature';
    if (g < fr.gE) return c + ' was planted but not yet up';
    if (c === 'corn' && g < fr.gV) return 'corn was small, with its growing point still below ground';
    if (g < fr.gR1 * 0.9) return c + ' was in leaf growth';
    if (c === 'corn') {
      var k = fr.mat / 2700;
      if (g < 1925 * k) return 'corn was early in grain fill';
      if (g < 2190 * k) return 'corn was at the milk stage';
      if (g < 2450 * k) return 'corn was at the dough stage';
      if (g < 2575 * k) return 'corn was at the dent stage';
      return 'corn was close to maturity (past half milk line)';
    }
    if (g < fr.mat * 0.9) return c + ' was filling pods';
    return c + ' was close to maturity';
  }
  function frostFieldText(fr) {
    if (fr.mature) return 'it came after the crop was mature, so it cost little';
    if (fr.loss > 0.005) return fr.killing ? 'a hard frost ended growth early: about ' + Math.round(fr.loss * 100) + '% of the crop lost' : 'about ' + Math.round(fr.loss * 100) + '% lost';
    if (fr.gdd < fr.gE) return 'no damage';
    if (fr.crop === 'corn' && fr.gdd < fr.gV) return 'leaves may burn but the plant regrows, so little or no loss';
    return fr.killing ? 'little loss' : 'a light frost, little or no loss';
  }

  function fieldEvents(field, ev, wf) {
    var out = [], W = wf.weeks, c = ev.crop, name = field.name, res = ev.res;
    function add(d, type, text, source) { out.push({ date: dayDate(d), fieldId: field.id, type: type, text: text, source: source }); }
    var heatBest = -1, droughtFirst = -1, droughtN = 0, wetFirst = -1, wetN = 0, eroFirst = -1;
    W.forEach(function (s, w) {
      var f = s.flags;
      if (f.indexOf('heat') >= 0 && (heatBest < 0 || wf.wk[w].hdd > wf.wk[heatBest].hdd)) heatBest = w;
      if (f.indexOf('drought') >= 0 && s.crop === c) { droughtN++; if (droughtFirst < 0) droughtFirst = w; }
      if (f.indexOf('waterlogged') >= 0) { wetN++; if (wetFirst < 0) wetFirst = w; }
      if (f.indexOf('erosion') >= 0 && eroFirst < 0) eroFirst = w;
    });
    // Event texts are shown to the farmer as written: plain words, short, only what the model computed.
    if (heatBest >= 0) add(heatBest * 7, 'heat', 'Hot days on ' + name + ' during ' + c + ' ' + (STAGE_TEXT[W[heatBest].stage] || 'growth') + '. This data cannot show how much yield they cost.', 'power');
    if (droughtFirst >= 0) add(droughtFirst * 7, 'drought', 'Dry spell on ' + name + ': the soil ran short of water for ' + droughtN + ' week' + (droughtN > 1 ? 's' : '') + '.', 'power');
    var fk = res.frostFall && res.frostFall.loss > 0.005 ? res.frostFall : res.frostSpring && res.frostSpring.loss > 0.005 ? res.frostSpring : null;
    if (fk) add(fk.d, 'frost', 'Frost on ' + name + ': ' + frostStageWords(fk) + '; ' + frostFieldText(fk), 'power');
    if (wetFirst >= 0) add(wetFirst * 7, 'waterlogged', 'Wet soil on ' + name + ' for ' + wetN + ' week' + (wetN > 1 ? 's' : '') + '. ' + (ev.soil.source === 'soilgrids' ? 'From its texture in the SoilGrids world soil map, this soil is guessed to be ' : 'The soil survey rates this soil ') + (ev.soil.drainage ? ev.soil.drainage.toLowerCase() : 'slow to drain') + ' and ' + (ev.soil.tiled ? 'you said it is tile drained, so it is treated as moderately well drained (how much the tile removes is not modelled).' : 'tile drainage is not modelled, so the real field may drain faster.'), 'nrcs');
    if (eroFirst >= 0) {
      var m0 = new Date(START + eroFirst * 7 * DAY).getUTCMonth(), m1 = new Date(START + (eroFirst * 7 + 6) * DAY).getUTCMonth(), cold = [11, 0, 1, 2].indexOf(m0) >= 0 || [11, 0, 1, 2].indexOf(m1) >= 0;
      add(eroFirst * 7, 'erosion', (cold ? 'Heavy rain or snowmelt' : 'Heavy rain') + ' on ' + name + ' while the soil had little cover: erosion risk.', 'power');
    }
    if (res.late > PLANT_LATE_FLAG && res.plantDay >= 0) {
      var why = res.waitWet >= res.waitCold * 2 ? 'the soil was too wet to work' : res.waitCold >= res.waitWet * 2 ? 'the soil was too cold' : 'the soil was too wet or too cold';
      add(res.targetPlant + PLANT_LATE_FLAG + 1, 'planting-delay', 'Planting of ' + c + ' on ' + name + ' waited ' + Math.round(res.late) + ' days because ' + why + (res.PD < 0.995 ? ' (late planting costs about ' + Math.round((1 - res.PD) * 100) + '% of yield)' : ''), 'power');
    }
    if (res.harvested) add(res.harvestDay, 'harvest', 'Harvest of ' + c + ' on ' + name + ' (about ' + Math.round(ev.bu) + ' bu/acre)', 'power');
    return out;
  }

  // frost nights of the season (shifted weather): last spring frost before 1 Jul and first fall frost after
  function frostDates(wx, sh) {
    var spring = -1, fall = -1, tn = dayWx(wx, sh).tn;
    for (var d = IDX.mar1; d < IDX.fallFrost; d++) if (tn[d] <= FROST_C) spring = d;
    for (d = IDX.fallFrost; d < N_DAYS; d++) if (tn[d] <= FROST_C) { fall = d; break; }
    return { spring: spring, fall: fall };
  }
  // what each cash crop was doing on a frost night, from the fields' own frost records
  function frostReport(metas, which) {
    var items = [];
    metas.forEach(function (m) {
      var fr = which === 'spring' ? m.ev.res.frostSpring : m.ev.res.frostFall;
      if (m.ev.crop !== 'none' && m.ev.crop !== 'oats' && fr) items.push({ f: m.f, fr: fr });
    });
    return items;
  }
  // crops not yet planted on a spring frost night, e.g. "; soybeans on North 80 and Creek 40 were not planted yet"
  function notYet(metas, which, d) {
    if (which !== 'spring') return '';
    var by = {};
    metas.forEach(function (m) { var r = m.ev.res; if ((m.ev.crop === 'corn' || m.ev.crop === 'soybean') && r.plantDay > d) (by[m.ev.crop] = by[m.ev.crop] || []).push(m.f.name); });
    return Object.keys(by).map(function (c) { return '; ' + (c === 'soybean' ? 'soybeans' : c) + ' on ' + joinNames(by[c]) + (by[c].length > 1 || c === 'soybean' ? ' were' : ' was') + ' not planted yet'; }).join('');
  }
  function joinNames(a) { return a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }
  function frostSentence(items) {
    // group fields by what happened, e.g. "corn on West 40 and South 120 was small ...; soybeans on North 80 were not yet up"
    var groups = {}, order = [];
    items.forEach(function (it) { var k = frostStageWords(it.fr) + '|' + frostFieldText(it.fr); if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(it.f.name); });
    return order.map(function (k) { var p = k.split('|'), s = p[0].replace(/^(corn|soybean|oats)/, function (c) { return c + ' on ' + joinNames(groups[k]); }); return s + ' (' + p[1] + ')'; }).join('; ');
  }

  // ================================================================ yields of every plan option in every season (cached per weather shift)
  var yieldCache = {};
  function yieldTable(farm, sh) {
    var C = climate(), ref = getRef(farm), key = shiftKey(sh) + '|' + ref.fit, t = yieldCache[key];
    if (t && t.clim === C && t.ref === ref) return t;
    var out = { clim: C, ref: ref, years: C.meta.years, farm: farm, sh: sh, fields: {}, opts: {} };
    farm.fields.forEach(function (f) {
      var opts = (FS.data.planOptions[f.lastCrop] || []).slice(), cur = FS.data.initialControls.crops.plans[f.id];
      if (opts.indexOf(cur) < 0) opts.unshift(cur);
      out.opts[f.id] = opts; out.fields[f.id] = {};
    });
    yieldCache[key] = out;
    return out;
  }
  // one plan on one field in every season, computed on first use (oats, never ranked, only when compare() asks)
  function ytPlan(yt, f, pid) {
    var per = yt.fields[f.id], o = per[pid];
    if (o) return o;
    var years = yt.years, heat = heatOf(), bu = new Float64Array(years.length), pct = new Float64Array(years.length), green = new Float64Array(years.length);
    var t0 = yt.sh.ts > 0 && WARM_LOSS[planInfo(pid).cashCrop] ? ytPlan(yieldTable(yt.farm, unwarmed(yt.sh)), f, pid) : null;   // shift-0 yields for the warming floor
    years.forEach(function (y, i) { var e = evalField(yt.farm, f, pid, baseWx(y), yt.sh, {}, yt.ref, false, heat, 1, t0 ? t0.pct[i] : null); bu[i] = e.bu; pct[i] = e.pct; green[i] = e.res.rootDays; });
    o = per[pid] = { bu: bu, pct: pct, green: green, crop: planInfo(pid).cashCrop, hasRye: planInfo(pid).hasRye };
    return o;
  }

  // ================================================================ comparing plans with the current plan (API_V2 sections 2-4)
  var PRIORITIES = { balanced: 1, profit: 1, risk: 1, cover: 1 };
  // plans the farmer will not grow: controls.other.exclude, an array of plan ids ([] or missing = none). A field's current plan is never dropped by callers.
  function excluded(controls, pid) { var x = controls && controls.other && controls.other.exclude; return Array.isArray(x) && x.length > 0 && x.indexOf(pid) >= 0; }
  var PLAN_WORDS = { 'soy': 'soybeans', 'rye-soy': 'a cereal rye cover crop, then soybeans', 'corn-corn': 'corn after corn (a second year of corn)', 'oats-cover': 'oats, then a summer cover crop',
                     'corn': 'corn', 'rye-corn': 'a cereal rye cover crop, then corn', 'soy-soy': 'soybeans after soybeans (a second year of soybeans)' };
  function planWords(pid) { return PLAN_WORDS[pid] || (FS.data.plans[pid] ? FS.data.plans[pid].label.toLowerCase() : pid); }
  function money0(v) { return '$' + Math.abs(Math.round(v)).toLocaleString('en-US'); }
  function moreLess(v) { return Math.round(v) === 0 ? 'about the same money' : 'about ' + money0(v) + (v > 0 ? ' more' : ' less') + ' per acre'; }
  function valErr(crop) {
    var v = VALIDATION && VALIDATION[crop] && VALIDATION[crop].process;
    return v && Number.isFinite(v.rmsePct) ? v.rmsePct : 8;   // 8 points if no validation was run (DESIGN fallback)
  }
  // the model's typical one-season error, in $/acre, for a comparison between two crops (validation RMSE x normal revenue)
  function errDollars(cropA, cropB) {
    var E = FS.data.economics, e = 0;
    [cropA, cropB].forEach(function (c) { if (c === 'corn' || c === 'soybean') e = Math.max(e, valErr(c) / 100 * E.normalYield[c] * E.price[c]); });
    return e;
  }
  function riskOf(w5) { return w5 < RISK_HIGH ? 'high' : w5 < RISK_LOW ? 'medium' : 'low'; }
  function moneyNoteFor(crop) { return crop === 'oats' ? 'Oats price and cost are rough guesses with no source yet, so money is not shown.' : null; }

  // cost-share share for this field's rye acres when the other fields' rye acres (from controls) are counted first
  function shareFor(farm, controls, fieldId, acres) {
    var used = 0, cap = capAcres(), plans = controls && controls.crops && controls.crops.plans || {}, ta = controls && controls.crops && controls.crops.trialAcres || {};
    farm.fields.forEach(function (f) {
      if (f.id === fieldId || !plans[f.id] || !FS.data.plans[plans[f.id]] || !planInfo(plans[f.id]).hasRye) return;
      used += clamp(ta[f.id] == null ? f.acres : ta[f.id], 0, f.acres);
    });
    return acres > 0 ? clamp((cap - used) / acres, 0, 1) : 1;
  }

  function riskK(crop) {
    var k = VALIDATION && VALIDATION.riskK && VALIDATION.riskK[crop];
    return Number.isFinite(k) && k >= 1 ? k : (crop === 'corn' || crop === 'soybean' ? RISK_K_DEFAULT : 1);
  }
  // yields of one plan in every season with the weather deviation from the plan's own median widened by k (risk numbers only)
  function widened(T) {
    var med = median(Array.prototype.slice.call(T.bu)), k = riskK(T.crop), out = new Float64Array(T.bu.length);
    for (var i = 0; i < out.length; i++) out[i] = Math.max(RISK_FLOOR * med, med + (T.bu[i] - med) * k);
    return out;
  }
  function lowest(a, n) { return a.slice().sort(function (x, y) { return x - y; }).slice(0, n); }
  function econWith(E, f) { var o = { price: {}, costPerAcre: {}, nitrogen: E.nitrogen, costShareRye: E.costShareRye }, k; for (k in E.price) o.price[k] = E.price[k]; for (k in E.costPerAcre) o.costPerAcre[k] = E.costPerAcre[k]; if (f) f(o); return o; }

  // statistics of one plan against the current plan on one field, over all seasons.
  // Cost-share is a one-time payment: it counts in full in "this season" and once in the n-season average (not every season).
  // worst5 / downside / badPlan / badCur use widened yields (see RISK_K_DEFAULT); delta, better and thisSeason use the model's own yields.
  // worst5 is the plan's own 5-worst-seasons average minus the current plan's (the same number the risk label and the risk ranking use).
  function planStats(farm, f, pid, controls, yt, yearSel, shareFrac, pr) {
    var E = FS.data.economics, o = otherOf(controls), cur = FS.data.initialControls.crops.plans[f.id];
    var A = ytPlan(yt, f, pid), B = ytPlan(yt, f, cur), n = yt.years.length, k = yt.years.indexOf(yearSel), isCur = pid === cur;
    var o0 = {}, key; for (key in o) o0[key] = o[key]; o0.costShare = false;
    var payA = csOn(o) && A.hasRye ? (E.costShareRye || 0) * (shareFrac == null ? 1 : shareFrac) : 0, payB = csOn(o) && B.hasRye ? (E.costShareRye || 0) : 0, pay = payA - payB;
    var bAw = widened(A), bBw = widened(B);
    function series(E2, scA, wide) {
      var bA = wide ? bAw : A.bu, bB = wide ? bBw : B.bu, rp = [], rc = [], d = [];
      for (var i = 0; i < n; i++) {
        var a = money(E2, o0, A.crop, f.lastCrop, bA[i] * scA, A.hasRye, 1).ret, b = money(E2, o0, B.crop, f.lastCrop, bB[i], B.hasRye, 1).ret;
        rp.push(a); rc.push(b); d.push(a - b);
      }
      return { rp: rp, rc: rc, d: d };
    }
    var base = series(E, 1, false), wide = series(E, 1, true), gsum = 0, i;
    for (i = 0; i < n; i++) gsum += A.green[i] - B.green[i];
    var delta = mean(base.d) + pay / n;
    var w5p = lowest(wide.rp, N_WORST), w5c = lowest(wide.rc, N_WORST), downside = mean(w5p) - mean(w5c);
    var s = { plan: pid, cur: cur, crop: A.crop, curCrop: B.crop, isCurrent: isCur, n: n,
              delta: delta, better: base.d.filter(function (x) { return x > 0.5; }).length, worst5: downside,
              downside: downside, badPlan: mean(w5p), badCur: mean(w5c), green: gsum / n / 30.4,
              thisSeason: k >= 0 ? base.d[k] + pay : null, pctThis: k >= 0 ? A.pct[k] : null, err: errDollars(A.crop, B.crop), errMean: errDollars(A.crop, B.crop) / Math.sqrt(n),
              flips: [], band: false, warm: yt.sh.ts > 0 };
    if (isCur) return s;
    // too close to call: the sign of the money result (the ranking metric for 'risk') flips under a plausible change of an input we cannot check
    function metric(E2, scA) {
      if (pr === 'risk') { var w = series(E2, scA, true); return mean(lowest(w.rp, N_WORST)) - mean(lowest(w.rc, N_WORST)); }
      return mean(series(E2, scA, false).d) + pay / n;
    }
    var m0 = metric(E, 1);
    function flipsUnder(variants) { return variants.some(function (v) { var m = metric(v[0], v[1]); return m * m0 < 0; }); }
    var pc = CLOSE.priceRatio;
    if (A.crop !== B.crop && flipsUnder([[econWith(E, function (x) { x.price.corn *= 1 + pc; }), 1], [econWith(E, function (x) { x.price.corn *= 1 - pc; }), 1]]))
      s.flips.push('the corn to soybean price ratio moves by ' + Math.round(pc * 100) + '%');
    if (A.crop === 'soybean' && f.lastCrop === 'soybean' && flipsUnder([[E, (1 - CLOSE.ssDrag[0]) / ROT_SS], [E, (1 - CLOSE.ssDrag[1]) / ROT_SS]]))
      s.flips.push('the soybean-after-soybean yield drag is anywhere between ' + CLOSE.ssDrag[0] * 100 + '% and ' + CLOSE.ssDrag[1] * 100 + '% (we use ' + Math.round((1 - ROT_SS) * 100) + '%, with no published source)');
    if (A.crop === 'corn' && f.lastCrop === 'corn') {
      var cc1 = (1 - (ROT_CC.base + CLOSE.ccDragPts)) / (1 - ROT_CC.base), cc2 = (1 - (ROT_CC.base - CLOSE.ccDragPts)) / (1 - ROT_CC.base);
      if (flipsUnder([[E, cc1], [E, cc2]])) s.flips.push('the corn-after-corn yield drag is ' + Math.round(CLOSE.ccDragPts * 100) + ' points bigger or smaller than the ' + Math.round(ROT_CC.base * 1000) / 10 + '% we use');
    }
    if ((A.hasRye || B.hasRye) && flipsUnder([[econWith(E, function (x) { x.costPerAcre.rye *= 1 + CLOSE.ryeCost; }), 1], [econWith(E, function (x) { x.costPerAcre.rye *= 1 - CLOSE.ryeCost; }), 1]]))
      s.flips.push('the rye seed and seeding cost is ' + Math.round(CLOSE.ryeCost * 100) + '% higher or lower');
    if ((A.crop === 'soybean' || B.crop === 'soybean') && A.crop !== 'none' && flipsUnder([[econWith(E, function (x) { x.costPerAcre.soybean *= 1 + CLOSE.soyCost; }), 1], [econWith(E, function (x) { x.costPerAcre.soybean *= 1 - CLOSE.soyCost; }), 1]]))
      s.flips.push('the soybean cost is ' + Math.round(CLOSE.soyCost * 100) + '% higher or lower');
    s.band = Math.abs(m0) < s.errMean;
    return s;
  }
  function priorityScore(s, pr) {
    if (pr === 'profit') return s.delta;
    if (pr === 'risk') return s.downside;
    if (pr === 'cover') return s.green * 1000 + s.delta / 1000;          // living-root months first, money breaks ties
    return (s.delta + s.downside) / 2;                                     // balanced: average of the profit and the bad-years difference, $/acre
  }
  // an option beats the current plan when its priority score is positive; for 'balanced' it must also not lose more on average than the
  // model's error for a 44-season average (so a plan that pays for safer bad years with a clear average loss is not offered as balanced)
  function beats(s, pr) {
    if (pr === 'cover') return s.green >= COVER_MIN_GAIN;
    if (pr === 'balanced') return priorityScore(s, pr) > 0.5 && s.delta > -s.errMean;
    return priorityScore(s, pr) > 0.5;
  }

  var BENEFITS = {
    'rye': 'Keeps living roots in the field about {g} more months a year. Iowa research (Iowa Nutrient Reduction Strategy) finds a rye cover crop cuts nitrate loss by about 31%; this tool does not put a dollar value on that.',
    'corn-corn': 'Keeps the same crop, equipment and marketing on this field as last year.',
    'soy-soy': 'Soybeans need no nitrogen fertiliser, which saves about {soyN} per acre (146 lb of N). Iowa State\'s budgets put soybeans about {soyCost} per acre below corn in all; the rest of that gap is seed, drying and other costs.',
    'oats-cover': 'A third crop breaks pest and disease cycles, and the summer cover keeps living roots in the field after oats harvest.',
    'current': 'No change to your rotation, equipment or marketing.'
  };
  var GAPS = {
    'rye': 'This tool does not put a dollar value on less nitrate loss, less erosion or weed control, and the $37 per acre rye cost is a rough guess with no source yet.',
    'corn-corn': 'The corn-after-corn yield drag (about 8%) comes from Iowa State budgets, not from your fields; rootworm and residue problems are not modelled separately.',
    'soy-soy': 'The soybean-after-soybean drag (7%) is a working value with no published source; disease and nematode build-up are not modelled.',
    'oats-cover': 'Oats price, cost and yield are rough guesses with no source yet, so the money result is not reliable.',
    'current': 'All results use one weather grid square of about 50 km and hold prices at today\'s levels.'
  };
  var RISKS = {
    'rye-corn': 'Plan to kill the rye 10-14 days before planting corn; Iowa State found about 4% less corn when rye was killed 3 days before planting.',
    'rye-soy': 'Check rye termination timing and herbicides with your agronomist; Iowa cost-share cannot be combined with the crop-insurance cover-crop discount.',
    'corn-corn': 'Check rootworm pressure, the nitrogen rate (about 190 lb N per acre after corn) and residue handling with your agronomist.',
    'soy-soy': 'Check this field\'s soybean cyst nematode and white mold history before planting soybeans twice.',
    'oats-cover': 'Find a local buyer and a price before planting; few elevators take oats.',
    'current': 'Nothing new to check.'
  };
  // API_V4 section 4: the extra work, and how to try the option on part of a field
  var WORK = {
    'rye': 'One extra pass to seed rye after harvest and one to end it 10-14 days before planting; a drill or a broadcast pass works.',
    'corn-corn': 'Same planter and combine as usual. Plan for more nitrogen (about 190 lb per acre) and a pass or two to deal with corn stalks.',
    'soy-soy': 'Same planter and combine as usual, and no nitrogen to apply. Plan seed treatment or scouting for disease.',
    'oats-cover': 'Two crops to handle: oats seeded in early April and cut in July, then a cover crop seeded in early August. You need a drill and somewhere to sell or store the oats.',
    'current': 'No change to your usual work.'
  };
  function trialSize(f, ta) { var n = Math.max(1, Math.floor(Math.min(20, f.acres / 2))); if (ta != null && ta > 0 && ta < f.acres) n = Math.max(1, Math.round(ta)); return n; }
  function kindOf(pid, isCurrent) { if (isCurrent) return 'current'; if (/^rye-/.test(pid)) return 'rye'; return pid; }
  function card(s, f, pr, sc, ref) {
    var E = FS.data.economics, kind = kindOf(s.plan, s.isCurrent), nY = s.n, yrs = ref.years[0] + '-' + ref.years[ref.years.length - 1];
    var why, ev, ben, gap, risk;
    if (s.isCurrent) {
      why = 'This is your current plan for ' + f.name + '; every other option is compared with it in the same weather and prices.';
      ev = (SITE && SITE.state && SITE.state !== 'IA')
        ? 'Over the ' + nY + ' real seasons ' + yrs + ' of NASA POWER weather on this field\'s soil, every other option is compared with it season by season. Its own dollar total is not shown outside Iowa, because the costs are Iowa State budgets.'
        : 'Over the ' + nY + ' real seasons ' + yrs + ' of NASA POWER weather on this field\'s soil, it made ' + money0(s.meanRet) + ' per acre on average' + (s.meanRet < 0 ? ' less than its full cost' : ' above its full cost') + ' (including land), before insurance.';
    } else {
      var head = { profit: 'Ranked by average profit: ', risk: 'Ranked by safety in bad years: ', cover: 'Ranked by ground cover: ', balanced: 'Ranked by a balance of average profit and bad years: ' }[pr];
      if (pr === 'risk') why = head + 'in its 5 worst seasons it averages ' + (s.badPlan < 0 ? '-' : '') + money0(s.badPlan) + ' per acre, versus ' + (s.badCur < 0 ? '-' : '') + money0(s.badCur) + ' for your current plan (weather swings are widened to match how much real Iowa yields varied).';
      else if (pr === 'cover') why = head + 'it keeps living roots in the field about ' + Math.abs(r1(s.green)) + (s.green >= 0 ? ' more' : ' fewer') + ' months a year, and makes ' + moreLess(s.delta) + ' than your current plan on average.';
      else why = head + 'it makes ' + moreLess(s.delta) + ' than your current plan on average' + (pr === 'balanced' ? ', and ' + moreLess(s.downside).replace('about the same money', 'about the same') + ' in the 5 worst seasons.' : '.');
      if (s.tooClose) {
        var cp_ = [];
        if (s.flips.length) cp_.push('Too close to call: the answer flips if ' + joinOr(s.flips) + '.');
        if (s.band) cp_.push((s.flips.length ? 'It is also' : 'Too close to call: it is') + ' smaller than the model\'s weather error for a ' + nY + '-season average (about ' + money0(s.errMean) + ' per acre).');
        why += ' ' + cp_.join(' ');
      }
      ev = 'Replayed ' + nY + ' real seasons (' + yrs + ') of NASA POWER weather on this field\'s NRCS soil: better than your current plan in ' + s.better + ' of ' + nY + ' seasons' +
           (s.thisSeason != null ? ', and ' + moreLess(s.thisSeason).replace('about the same money', 'about the same') + ' in ' + sc.phrase + ' (one season: the model can be off by about ' + money0(s.err) + ' per acre)' : '') + '.';
    }
    ben = BENEFITS[kind] || BENEFITS.current;
    ben = ben.replace('{g}', String(Math.abs(r1(s.green)))).replace('{soyCost}', money0(E.costPerAcre.corn - E.costPerAcre.soybean)).replace('{soyN}', money0((E.nitrogen.lbPerAcreCornAfterSoy || 0) * (E.nitrogen.dollarsPerLb || 0)));
    if (kind === 'rye' && s.costShare > 0) ben += ' Iowa cost-share pays $' + Math.round(E.costShareRye * s.costShare) + ' per acre for first-time cover crops (up to ' + capAcres() + ' acres).';
    gap = (GAPS[kind] || GAPS.current) + ' The ' + (s.crop === 'soybean' ? 'soybean' : 'corn') + ' yield model is typically off by about ' + Math.round(valErr(s.crop === 'soybean' ? 'soybean' : 'corn')) + ' points of a normal crop in a single season. ' +
          'Heat damage cannot be estimated from this data, so hot-year losses are probably understated' +
          (s.warm ? '; with warming, yields are held to at least the published average loss (corn 7.4% and soybeans 3.1% per degree, Zhao et al. 2017)' : '') +
          '. ' + tileWords();
    risk = RISKS[s.plan] || (s.isCurrent ? RISKS.current : RISKS[kind]) || RISKS.current;
    if (s.moneyNote) {
      why = s.moneyNote + ' ' + (s.isCurrent ? why : 'Oats is shown for comparison of ground cover and yield only.');
      if (!s.isCurrent) ev = 'Replayed ' + nY + ' real seasons (' + yrs + ') of NASA POWER weather on this field\'s NRCS soil: oats yield about ' + Math.round(s.pctThis == null ? 100 : s.pctThis) +
        '% of a normal crop in ' + sc.phrase + ', and the field has living roots about ' + Math.abs(r1(s.green)) + (s.green >= 0 ? ' more' : ' fewer') + ' months a year than with your current plan.';
    }
    if (SITE.state !== 'IA') {
      gap += ' Costs are Iowa State budgets; check your local costs.';
      if (kind === 'rye') { ben = ben.replace(/ Iowa cost-share pays \$(\d+) per acre for first-time cover crops \(up to (\d+) acres\)\./, ' The cost-share used here is Iowa\'s ($$1 per acre, up to $2 acres); check your state\'s program.'); }
      risk = risk.replace('Iowa cost-share cannot be combined', 'Cost-share programs may not be combinable');
    }
    if (s.irr && s.irr !== 'none') gap += ' Irrigation cost is a working value: ' + IRR_KWH_PER_ACRE_IN + ' kWh of electricity per acre-inch (University of Nebraska-Lincoln, 150-foot lift, 60 psi) at an assumed $' + IRR_DOLLARS_PER_KWH.toFixed(2) + ' per kWh, about $' + IRR_COST_PER_ACRE_IN.toFixed(2) + ' per acre-inch; equipment, labour and water rights are not counted, and the water goes on every field whatever the soil holds.';
    var work = WORK[kind] || WORK.current, tryS = s.isCurrent ? 'Nothing to try: this is your current plan.' : 'Try it on ' + trialSize(f, s.trialAcres) + ' acres of ' + f.name + ' next to your usual plan and compare at harvest.';
    return { why: why, evidence: ev, benefits: ben, gaps: gap, risks: risk, work: work, trySmall: tryS };
  }

  function statsItem(farm, f, pid, controls, yt, sc, pr, ref, shareFrac) {
    var s = planStats(farm, f, pid, controls, yt, sc.year, shareFrac, pr), o = otherOf(controls), E = FS.data.economics;
    // too close to call: the sign flips under a plausible change of a price, yield drag or cost (planStats), or the difference is smaller than
    // the weather error band (one-season validation RMSE in $/acre divided by the square root of the number of seasons)
    s.tooClose = !s.isCurrent && (s.flips.length > 0 || s.band);
    s.moneyNote = moneyNoteFor(s.crop);
    s.costShare = csOn(o) ? shareFrac : 0;
    s.irr = controls && controls.crops && controls.crops.irrigation || 'none';
    s.trialAcres = controls && controls.crops && controls.crops.trialAcres && controls.crops.trialAcres[f.id];
    if (s.isCurrent) { var B = ytPlan(yt, f, pid), tot = 0; for (var i = 0; i < s.n; i++) tot += money(E, o, B.crop, f.lastCrop, B.bu[i], B.hasRye, 1).ret; s.meanRet = tot / s.n; }
    return s;
  }
  function itemOut(s, f, pr, sc, ref, withTitle) {
    var o = { plan: s.plan, label: FS.data.plans[s.plan].label, isCurrent: s.isCurrent,
              deltaPerAcre: s.isCurrent ? 0 : Math.round(s.delta), deltaThisSeason: s.isCurrent || s.thisSeason == null ? 0 : Math.round(s.thisSeason),
              betterSeasons: s.isCurrent ? 0 : s.better, nSeasons: s.n, worst5PerAcre: s.isCurrent ? 0 : Math.round(s.worst5),
              greenCoverMonthsAdded: s.isCurrent ? 0 : r1(s.green), yieldPctThisSeason: s.pctThis == null ? null : Math.round(s.pctThis),
              risk: s.isCurrent ? 'low' : riskOf(s.worst5), tooClose: !!s.tooClose, card: card(s, f, pr, sc, ref), moneyNote: s.moneyNote };
    if (withTitle) o.title = (s.crop === 'none' ? FS.data.plans[s.plan].label : cap1(planWords(s.plan))) + ' on ' + f.name;
    return o;
  }
  function joinOr(a) { return a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' or ' + a[a.length - 1]; }
  function cap1(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  // FS.engine.compare(fieldId, controls): every valid plan for the field, current plan first
  function compare(fieldId, controls) {
    var farm = FS.data.farm, f = farm.fields.filter(function (x) { return x.id === fieldId; })[0];
    if (!f) return [];
    controls = controls || FS.data.initialControls;
    var w = controls.weather || {}, sh = shiftOf(w, controls.crops), yt = yieldTable(farm, sh), ref = getRef(farm), sc = scenario(w.scenario || 'typical');
    var pr = PRIORITIES[controls.other && controls.other.priority] ? controls.other.priority : 'balanced', cur = FS.data.initialControls.crops.plans[f.id];
    var share = shareFor(farm, controls, f.id, f.acres), ids = yt.opts[f.id].slice();
    ids = ids.filter(function (pid) { return pid === cur || !excluded(controls, pid); });
    ids.sort(function (a, b) { return (a === cur ? -1 : 0) - (b === cur ? -1 : 0); });
    return ids.map(function (pid) { return itemOut(statsItem(farm, f, pid, controls, yt, sc, pr, ref, share), f, pr, sc, ref, false); });
  }

  // FS.engine.seasons(fieldId, controls) (API_V3 section 3): the current plan and the chosen plan in every past season under the same controls, from the cached yield table
  function seasons(fieldId, controls) {
    var farm = FS.data.farm, f = farm.fields.filter(function (x) { return x.id === fieldId; })[0];
    if (!f) return null;
    controls = controls || FS.data.initialControls;
    var w = controls.weather || {}, sh = shiftOf(w, controls.crops), yt = yieldTable(farm, sh), E = FS.data.economics, o = otherOf(controls);
    var cur = FS.data.initialControls.crops.plans[f.id], req = controls.crops && controls.crops.plans && controls.crops.plans[f.id];
    var pid = req && FS.data.plans[req] ? req : cur, share = shareFor(farm, controls, f.id, f.acres), n = yt.years.length;
    function side(id, sf) {
      var T = ytPlan(yt, f, id), hide = !!moneyNoteFor(T.crop) || T.crop === 'none', pct = [], per = [];
      for (var i = 0; i < n; i++) {
        pct.push(r1(T.pct[i]));
        per.push(hide ? null : Math.round(money(E, o, T.crop, f.lastCrop, T.bu[i], T.hasRye, sf).ret));
      }
      return { plan: id, pct: pct, perAcre: per };
    }
    var a = side(cur, 1), b = pid === cur ? { plan: pid, pct: a.pct.slice(), perAcre: a.perAcre.slice() } : side(pid, share), diff = [];
    for (var i = 0; i < n; i++) diff.push(a.perAcre[i] == null || b.perAcre[i] == null ? null : b.perAcre[i] - a.perAcre[i]);
    return { fieldId: fieldId, years: yt.years.slice(), current: a, plan: b, diffPerAcre: diff };
  }

  // summary.recommendations: alternatives that beat the current plan on the chosen priority, at most 3 (oats excluded)
  function recommendations(farm, controls, ref) {
    var w = controls.weather || {}, sh = shiftOf(w, controls.crops), yt = yieldTable(farm, sh), sc = scenario(w.scenario || 'typical');
    var pr = PRIORITIES[controls.other && controls.other.priority] ? controls.other.priority : 'balanced', init = FS.data.initialControls.crops.plans, cands = [];
    farm.fields.forEach(function (f) {
      yt.opts[f.id].forEach(function (pid) {
        if (pid === init[f.id] || planInfo(pid).cashCrop === 'oats') return;      // oats: placeholder economics, selectable but never ranked
        if (excluded(controls, pid)) return;                                      // a plan the farmer will not grow (controls.other.exclude)
        var share = shareFor(farm, { crops: { plans: init, trialAcres: {} } }, f.id, f.acres);
        var s = statsItem(farm, f, pid, controls, yt, sc, pr, ref, share);
        s.score = priorityScore(s, pr); s.f = f;
        if (beats(s, pr)) cands.push(s);
      });
    });
    cands.sort(function (a, b) { return b.score - a.score; });
    var used = {}, top = [];
    cands.forEach(function (c) { if (!used[c.f.id] && top.length < 3) { used[c.f.id] = 1; top.push(c); } });
    cands.forEach(function (c) { if (top.length < 3 && top.indexOf(c) < 0) top.push(c); });
    var recs = top.map(function (s, i) {
      var o = itemOut(s, s.f, pr, sc, ref, true);
      return { rank: i + 1, fieldId: s.f.id, plan: s.plan, title: o.title, deltaPerAcre: o.deltaPerAcre, deltaThisSeason: o.deltaThisSeason,
               betterSeasons: o.betterSeasons, nSeasons: o.nSeasons, worst5PerAcre: o.worst5PerAcre, greenCoverMonthsAdded: o.greenCoverMonthsAdded,
               risk: o.risk, tooClose: o.tooClose, card: o.card, why: o.card.why, moneyNote: o.moneyNote, source: 'power' };
    });
    var NOTE = {
      profit: 'At today\'s prices, keeping your current plans earns the most on average over the past ' + ref.years.length + ' seasons.',
      risk: 'Your current plans already have the best bad years of the options tried.',
      cover: 'No option adds ground cover over your current plans.',
      balanced: 'At today\'s prices, keeping your current plans gives the best balance of average profit and results in bad years over the past ' + ref.years.length + ' seasons.'
    };
    var note = recs.length ? null : NOTE[pr];
    if (recs.length && recs.every(function (r) { return r.tooClose; })) note = 'The options below are close calls: their advantage flips under plausible changes to prices, yield drags or costs, or is within the model\'s weather error.';
    return { recs: recs, note: note };
  }

  // ================================================================ run
  function sign(v) { return v > 0 ? '+' + v : v < 0 ? '−' + Math.abs(v) : '0'; }
  function makeLabel(sc, c) {
    var parts = [sc.label];
    if (c.weather.tempShift) parts.push(sign(c.weather.tempShift) + '°C');
    if (c.weather.rainChange) parts.push('rain ' + sign(c.weather.rainChange) + '%');
    if (c.crops && c.crops.plantShiftDays) parts.push('plant ' + Math.abs(c.crops.plantShiftDays) + ' d ' + (c.crops.plantShiftDays < 0 ? 'earlier' : 'later'));
    var cev = cleanEvents(c.weather.events);
    if (cev.length) parts.push(cev.map(function (e) { return (e.severity === 'severe' ? 'severe ' : '') + (e.type === 'heatwave' ? 'heat wave ' : EVENT_NAMES[e.type] + ' ') + MONTHS[e.month - 1]; }).join(', '));
    if (c.other.priceChange) parts.push('price ' + sign(c.other.priceChange) + '%');
    if (c.other.nitrogenChange) parts.push('nitrogen ' + sign(c.other.nitrogenChange) + '%');
    return parts.join(' · ');
  }
  function validationText() {
    var v = VALIDATION;
    if (!v || !v.corn) return 'Calibrated so 2012 matches Iowa\'s real loss; not yet checked against other years.';
    return v.text;
  }

  function run(input) {
    var farm = input.farm || FS.data.farm, controls = input.controls, baseline = input.baseline || null;
    var heat = heatOf(), ref = getRef(farm), other = otherOf(controls);
    var sc = scenario(controls.weather.scenario), year = sc.year, wx = baseWx(year), sh = shiftOf(controls.weather, controls.crops);
    var wxW = [], weeks = [], dwr = dayWx(wx, sh);
    for (var w = 0; w < N_WEEKS; w++) {
      var a = w * 7, z = Math.min(N_DAYS - 1, a + 6), mx = -99, rn = 0, hv = false, fr = false, ht = false;
      for (var d = a; d <= z; d++) {
        var tx = dwr.tx[d], tn = dwr.tn[d], p = dwr.P[d];
        if (tx > mx) mx = tx; rn += p; if (p >= HEAVY_RAIN_MM) hv = true; if (tn <= FROST_C) fr = true; if (tx > heat.c35) ht = true;
      }
      var wo = { tmaxC: r1(mx), rainMm: r1(rn), heavyRain: hv, frost: fr, heat: ht };
      wxW.push(wo);
      weeks.push({ date: isoOf(START + w * 7 * DAY), label: fmtLabel(START + w * 7 * DAY), weather: wo, fields: {} });
    }
    var init = FS.data.initialControls.crops.plans, fieldsOut = {}, events = [], metas = [], totalRet = 0, totalVs = 0, totalAcres = 0;
    // cost-share 160-acre cap across the farm, fields in farm order
    var capLeft = capAcres();
    farm.fields.forEach(function (f) {
      var planReq = controls.crops.plans[f.id] || init[f.id], cur = init[f.id], ta = controls.crops.trialAcres && controls.crops.trialAcres[f.id];
      var trial = clamp(ta == null ? f.acres : ta, 0, f.acres);
      var planId = trial > 0 ? planReq : cur;                  // 0 trial acres: the field stays on its current plan
      var share = 1;
      if (planInfo(planId).hasRye) { var ryeAc = planId === cur ? f.acres : trial; share = ryeAc > 0 ? clamp(capLeft / ryeAc, 0, 1) : 1; capLeft = Math.max(0, capLeft - ryeAc); }
      var ev = evalField(farm, f, planId, wx, sh, other, ref, true, heat, share), wf = weeklyField(ev, f, heat);
      wf.weeks.forEach(function (s, i) { weeks[i].fields[f.id] = s; });
      var retField = ev.ret, rest = f.acres - trial;
      if (rest > 0 && cur !== planId) retField = (ev.ret * trial + evalField(farm, f, cur, wx, sh, other, ref, false, heat, 1).ret * rest) / f.acres;
      retField = Math.round(retField);
      var base = baseline && baseline.summary && baseline.summary.fields && baseline.summary.fields[f.id], vs = base ? retField - base.returnPerAcre : 0;
      var cropName = ev.crop, res = ev.res;
      var worst = wf.worst, wDate = worst.w >= 0 && worst.v >= 0.005 ? dayDate(worst.w * 7) : null;
      var note;
      if (cropName === 'none') note = 'No cash crop planned';
      else if (!wDate) note = (res.late > PLANT_LATE_FLAG ? 'Planted ' + Math.round(res.late) + ' days after the target date; no other major stress' : 'No major stress for ' + cropName);
      else {
        var cs = { frost: 'Frost during', heat: 'Heat during', drought: 'Dry soil during', wet: 'Waterlogged soil during' }[worst.cause], sg = STAGE_TEXT[wf.weeks[worst.w].stage] || 'growth';
        note = cs + ' ' + cropName + ' ' + sg + (res.late > PLANT_LATE_FLAG ? '; planted ' + Math.round(res.late) + ' days after the target date' : '');
      }
      if (cropName === 'oats') note += '; oats price and cost are rough guesses with no source yet, needs a local buyer';
      fieldsOut[f.id] = { plan: planId, planLabel: ev.plan.label, crop: cropName, acres: f.acres, trialAcres: planId === cur && planReq !== cur ? 0 : trial,
        yieldPctOfNormal: Math.round(ev.pct), yieldBuPerAcre: r1(ev.bu), returnPerAcre: retField, returnVsBaselinePerAcre: vs,
        greenCoverMonths: r1(res.rootDays / 30.4), worstWeek: wDate, note: note, moneyNote: moneyNoteFor(cropName) };
      totalRet += retField * f.acres; totalVs += vs * f.acres; totalAcres += f.acres;
      metas.push({ f: f, ev: ev, wf: wf });
      events = events.concat(fieldEvents(f, ev, wf));
    });
    // farm-level events: heavy rain and the frost nights that found crops in the field
    var heavyN = 0, heavyDay = -1, heavyMax = 0;
    for (var d2 = 0; d2 < N_DAYS; d2++) { var pp = dwr.P[d2]; if (pp >= HEAVY_RAIN_MM) { heavyN++; if (pp > heavyMax) { heavyMax = pp; heavyDay = d2; } } }
    if (heavyN >= 1) events.push({ date: dayDate(heavyDay), fieldId: null, type: 'heavy-rain', source: 'power',
      text: heavyN === 1 ? 'One day of heavy rain: ' + Math.round(heavyMax) + ' mm in a day.' : 'Heaviest rain of the year: ' + Math.round(heavyMax) + ' mm in one day. In all, ' + heavyN + ' days had ' + HEAVY_RAIN_MM + ' mm or more.' });
    var fd = frostDates(wx, sh), frost = { spring: frostReport(metas, 'spring'), fall: frostReport(metas, 'fall'), dates: fd };
    ['spring', 'fall'].forEach(function (k) {
      if (!frost[k].length) return;
      var dd = frost[k][0].fr.d;
      events.push({ date: dayDate(dd), fieldId: null, type: 'frost', text: (k === 'spring' ? 'Last spring frost' : 'First fall frost') + ' on ' + dayWords(dd) + ': ' + frostSentence(frost[k]) + '.', source: 'power' });
    });
    events.sort(function (x, y) { return x.date < y.date ? -1 : x.date > y.date ? 1 : 0; });
    var rec = recommendations(farm, controls, ref);
    return {
      runId: 0, label: makeLabel(sc, controls), sample: !!(FS.data && FS.data.sample), inputs: controls, weeks: weeks,
      summary: { farm: { acres: totalAcres, returnTotal: Math.round(totalRet), returnVsBaselineTotal: Math.round(totalVs) },
                 fields: fieldsOut, events: events, why: buildWhy(controls, sc, year, wx, sh, metas, ref, frost),
                 recommendations: rec.recs, recommendationNote: rec.note, validation: { text: validationText() } }
    };
  }

  function buildWhy(controls, sc, year, wx, sh, metas, ref, frost) {
    var why = [], jja = 0, acres = 0, L = { dry: 0, heat: 0, frost: 0, wet: 0, late: 0 };
    for (var d = IDX.jun1; d <= IDX.aug31; d++) jja += dayWx(wx, sh).P[d];
    var pct = (jja / ref.medRainJJA - 1) * 100;
    metas.forEach(function (m) {
      var r = m.ev.res, a = m.f.acres; if (m.ev.crop === 'none' || m.ev.crop === 'oats') return;
      var g = (FIT[m.ev.crop] || FIT.corn).gamma;
      acres += a; L.dry += a * (1 - Math.pow(r.Yw, g)); L.heat += a * (1 - Math.pow(r.Yh, g)); L.frost += a * (1 - r.Yf); L.wet += a * (1 - Math.pow(r.Yww, g)); L.late += a * (1 - r.PD);
    });
    var best = null, k;
    for (k in L) { L[k] = acres ? L[k] / acres : 0; if (!best || L[k] > L[best]) best = k; }
    var rn = Math.abs(Math.round(pct)), yrs = ref.years[0] + '-' + ref.years[ref.years.length - 1];
    var rainWords = rn < 10 ? 'near normal' : rn + '% ' + (pct < 0 ? 'below' : 'above') + ' the ' + yrs + ' median';
    var isFrostSc = sc.id === 'lateFreeze' || sc.id === 'earlyFrost';
    if (isFrostSc) {
      var which = sc.id === 'lateFreeze' ? 'spring' : 'fall', items = frost[which], dd = which === 'spring' ? frost.dates.spring : frost.dates.fall;
      var lossMax = 0; items.forEach(function (it) { lossMax = Math.max(lossMax, it.fr.loss); });
      if (dd < 0) why.push({ text: 'With this temperature change there was no ' + which + ' frost night in this season.', source: 'power' });
      else if (!items.length) why.push({ text: 'The ' + (which === 'spring' ? 'last spring' : 'first fall') + ' frost came on ' + realDayWords(dd, year) + ', when no crop was in the field ' + (which === 'spring' ? 'yet' : 'any more') + ', so it did no damage.', source: 'power' });
      else why.push({ text: 'The ' + (which === 'spring' ? 'last spring' : 'first fall') + ' frost came on ' + realDayWords(items[0].fr.d, year) + ': ' + frostSentence(items) + notYet(metas, which, items[0].fr.d) + ', so ' +
                       (lossMax > 0.005 ? 'it cost up to ' + Math.round(lossMax * 100) + '% on the worst field.' : 'the frost itself cost little or nothing.') +
                       (L[best] >= 0.03 && best !== 'frost' ? ' The bigger effect this year was ' + { dry: 'dry soil', heat: 'heat', wet: 'waterlogged soil', late: 'late planting' }[best] + '.' : ''), source: 'power' });
    } else if (L[best] < 0.03) why.push({ text: 'No single weather problem stood out: rain from June to August was ' + rainWords + ' and crops lost little to heat, frost or dry soil.', source: 'power' });
    else if (best === 'dry') why.push({ text: 'Rain from June to August was ' + rainWords + ', and dry soil during flowering and grain fill cost the most yield.', source: 'power' });
    else if (best === 'heat') why.push({ text: 'Hot days cost the most yield here, but heat damage is not measured in this data, so treat the size of the loss as rough. NASA POWER also runs warm in hot summers.', source: 'power' });
    else if (best === 'frost') {
      var it0 = frost.fall.filter(function (x) { return x.fr.loss > 0.005; })[0] || frost.spring.filter(function (x) { return x.fr.loss > 0.005; })[0];
      why.push({ text: it0 ? 'A hard frost on ' + realDayWords(it0.fr.d, year) + ' caught the crop before it finished (' + frostStageWords(it0.fr) + '), which cost the most yield.' : 'A killing frost caught the crop before it finished, which cost the most yield.', source: 'power' });
    } else if (best === 'wet') why.push({ text: 'Soils the soil survey rates as slow to drain stayed saturated in May and June, which cost the most yield. ' + tileWords(), source: 'nrcs' });
    else why.push({ text: 'Planting went in late because fields were too wet or too cold in spring, which cost the most yield.', source: 'power' });
    var yl = sc.id === 'typical' ? 'the ' + year + ' season (a typical season\'s weather)' : 'the real ' + year + ' season';
    why.push({ text: 'Weather is ' + yl + ' from NASA POWER for one ~50 km grid square shared by all four fields; soils from NRCS; costs from Iowa State 2026 budgets at today\'s prices; before insurance; not a forecast.' +
      (sc.id === 'drought2012' || sc.id === 'drought1988' ? ' Prices are held at today\'s level; in the real ' + year + ' drought prices rose sharply, which softened the losses.' : ''), source: 'power' });
    why.push({ text: 'The weather response was checked against Iowa yields from USDA NASS: it catches the big droughts but is no better than the yield trend in ordinary years, and heat damage cannot be estimated from that data. The rotation, cover-crop and planting-date effects come from Iowa State trials and are not covered by that check.', source: 'isu' });
    if (sh.ts || controls.weather.rainChange) why.push({ text: 'Weather was adjusted' + (sh.ts ? ' by ' + sign(sh.ts) + '°C' : '') + (controls.weather.rainChange ? (sh.ts ? ' and' : '') + ' rain ' + sign(controls.weather.rainChange) + '%' : '') + '; the rain change makes storms heavier, not more frequent, and the corn hybrid stays the one matched to today\'s climate.' +
      (sh.ts > 0 ? ' For warming, each field\'s yield is held to at least the published average loss (corn 7.4% and soybeans 3.1% for each degree, Zhao et al. 2017, with no CO2 gain or adaptation), because heat damage cannot be estimated from this data.' : ''), source: 'power' });
    if (sh.pd) why.push({ text: 'Planting ' + Math.abs(sh.pd) + ' days ' + (sh.pd < 0 ? 'earlier' : 'later') + ' than usual on every field. Each crop still waits for workable soil, then follows the frost and growing-season rules; the yield cost of late planting comes from Iowa State planting-date trials, and early planting can lose to a cold spring or a spring frost. This planting-date effect was not checked against the NASS yields.', source: 'isu' });
    if (sh.ev.length) {
      var names = sh.ev.map(function (e) { return 'a ' + (e.severity === 'severe' ? 'severe ' : '') + (e.type === 'heatwave' ? 'heat wave in ' : EVENT_NAMES[e.type] + ' ') + MONTHS_LONG[e.month - 1]; }), hw = sh.ev.some(function (e) { return e.type === 'heatwave'; });
      var rainEv = sh.ev.some(function (e) { return e.type !== 'heatwave'; });
      why.push({ text: 'Weather events added to the replayed season: ' + names.join(', ') + '.' + (rainEv ? ' A dry or wet month scales that month\'s rain.' : '') +
        (hw ? ' A heat wave makes days 10 to 19 of that month hotter, which raises how much water the crops use. This data cannot show how much yield heat itself costs, so the result is mostly extra water use, and no separate heat damage is counted.' : ''), source: 'power' });
    }
    var extra = 0;
    if (sh.irr && sh.irr !== 'none') {
      why.splice(1, 0, { text: 'Irrigating an inch a week ' + (sh.irr === 'jun-aug' ? 'from June to August' : 'in ' + IRR_WORDS[sh.irr]) + ' on every field (' + r1(irrInches(sh.irr)) + ' inches in all). Pumping is charged at about $' + Math.round(irrCostPerAcre(sh.irr)) + ' per acre, a working value (energy only).', source: 'power' }); extra++;
    }
    if (!SITE.validated) {
      why.splice(1 + extra, 0, { text: 'This location was not checked against its own county\'s harvests; the yield check was done for Story County, Iowa.', source: 'isu' }); extra++;
    }
    var cov = metas.filter(function (m) { return m.ev.plan.hasRye; })[0], bare = metas.filter(function (m) { return !m.ev.plan.hasRye && m.ev.crop !== 'none'; })[0];
    if (cov) why.push({ text: 'The cover crop kept living roots in ' + cov.f.name + ' about ' + r1(cov.ev.res.rootDays / 30.4) + ' months' + (bare ? ' versus ' + r1(bare.ev.res.rootDays / 30.4) + ' on ' + bare.f.name : '') + '; living roots help hold soil and water, but this tool does not measure erosion.', source: 'power' });
    return why.slice(0, 8 + extra);
  }

  // ================================================================ farm setup (API_V4 section 2)
  var SITE = { id: 'story-ia', name: 'Story County, Iowa', short: 'Story Co., IA', state: 'IA', validated: true };
  var ORIG = null;
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function origFarm() {
    if (ORIG) return ORIG;
    var D = FS.data, f = D.farm;
    ORIG = { climate: D.climate, place: f.place, lat: f.lat, lon: f.lon, county: f.countyAwcMmPerM,
             fields: f.fields.map(function (x) { return { id: x.id, name: x.name, acres: x.acres, lastCrop: x.lastCrop, soil: clone(x.soil), poly: clone(x.poly) }; }),
             objs: f.fields.slice(), scenery: clone(f.scenery),
             plans: clone(D.initialControls.crops.plans), trial: clone(D.initialControls.crops.trialAcres), normal: clone(D.economics.normalYield),
             scenarios: clone(D.weatherScenarios || []) };
    return ORIG;
  }
  function resetCaches() {
    wxCache = { clim: null, years: {} }; dayCache = { clim: null, map: {}, n: 0 }; planCache = {}; shiftedCache = {};
    hybCache = { clim: null, val: null }; chainCache = {}; refCache = null; yieldCache = {};
  }
  function sumRain(w, a, z) { var t = 0; for (var d = a; d <= z; d++) t += w.rain[d]; return t; }
  function gddMaySep(w) { var t = 0, a = idxMD('05-01'), z = idxMD('09-30'); for (var d = a; d <= z; d++) t += gddOf(w.tmax[d], w.tmin[d], 50); return t; }
  function sdev(a) { var m = mean(a), t = 0; a.forEach(function (x) { t += (x - m) * (x - m); }); return Math.sqrt(t / (a.length - 1)); }
  // the typical year, the same rule as Story's 2011 (tools/validate.py scenario_checks): the season closest to the median in BOTH June-August rain
  // and May-September growing degree-days (standardised distance); the first two seasons (no radiation in the data) are skipped
  function pickTypical() {
    var years = climate().meta.years, jja = [], gdd = [];
    years.forEach(function (y) { var w = baseWx(y); jja.push(sumRain(w, IDX.jun1, IDX.aug31)); gdd.push(gddMaySep(w)); });
    var mj = median(jja), mg = median(gdd), sj = sdev(jja), sg = sdev(gdd), best = -1, bd = Infinity;
    years.forEach(function (y, i) { if (y < 1984) return; var d = Math.hypot((jja[i] - mj) / sj, (gdd[i] - mg) / sg); if (d < bd) { bd = d; best = i; } });
    return { year: years[best >= 0 ? best : 0], jja: jja[best], medJJA: mj, years: years };
  }
  function frostWords(year) {
    var w = baseWx(year), spring = -1, fall = -1, d;
    for (d = IDX.mar1; d < IDX.fallFrost; d++) if (w.tmin[d] <= FROST_C) spring = d;
    for (d = IDX.fallFrost; d < N_DAYS; d++) if (w.tmin[d] <= FROST_C) { fall = d; break; }
    return { spring: spring < 0 ? null : realDayWords(spring, year), fall: fall < 0 ? null : realDayWords(fall, year) };
  }
  function WXN() { var m = climate().meta || {}; return m.short || 'NASA POWER'; }
  function setScenarios(isStory) {
    var list = FS.data.weatherScenarios || [], O = ORIG.scenarios;
    if (isStory) { list.forEach(function (s, i) { var k; for (k in s) delete s[k]; for (k in O[i]) s[k] = O[i][k]; }); return; }
    var T = pickTypical(), yrs = T.years, span = yrs[0] + '-' + yrs[yrs.length - 1];
    function rn(a, z, y) { return Math.round(sumRain(baseWx(y), a, z)); }
    function rmed(a, z) { return Math.round(median(yrs.map(function (y) { return sumRain(baseWx(y), a, z); }))); }
    function jjaNote(y, what) { return what + ' Real ' + y + ' weather from ' + WXN() + ' at this location: June-August rain ' + rn(IDX.jun1, IDX.aug31, y) + ' mm against a ' + span + ' median of ' + rmed(IDX.jun1, IDX.aug31) + ' mm.'; }
    list.forEach(function (s) {
      var o = O.filter(function (x) { return x.id === s.id; })[0] || s, k; for (k in s) delete s[k]; for (k in o) s[k] = o[k];
      var fw;
      if (s.id === 'typical') { s.year = T.year; s.label = 'Typical season (' + T.year + ' weather)'; s.phrase = 'a typical season\'s weather (' + T.year + ')';
        s.note = 'Closest of the ' + yrs.length + ' seasons to the middle of the record in both June-August rain (' + Math.round(T.jja) + ' mm here against a ' + span + ' median of ' + Math.round(T.medJJA) + ' mm) and summer warmth.'; }
      else if (s.id === 'drought2012' || s.id === 'drought1988') s.note = jjaNote(s.year, 'Drought and heat across the Corn Belt.');
      else if (s.id === 'dry2023') s.note = jjaNote(s.year, 'A dry summer.');
      else if (s.id === 'wetSpring') s.note = 'Real ' + s.year + ' weather from ' + WXN() + ' at this location: April-June rain ' + rn(IDX.apr1, IDX.jun30, s.year) + ' mm against a ' + span + ' median of ' + rmed(IDX.apr1, IDX.jun30) + ' mm.';
      else if (s.id === 'lateFreeze') { fw = frostWords(s.year); s.phrase = 'the ' + s.year + ' season'; s.note = fw.spring ? 'Last spring frost night here (0 C or colder in ' + WXN() + '): ' + fw.spring + '.' : 'No spring frost night at this location in ' + s.year + '.'; }
      else if (s.id === 'earlyFrost') { fw = frostWords(s.year); s.phrase = 'the ' + s.year + ' season'; s.note = fw.fall ? 'First fall frost night here (0 C or colder in ' + WXN() + '): ' + fw.fall + '.' : 'No fall frost night at this location in ' + s.year + '.'; }
    });
  }
  // ---------------------------------------------------------------- fitting a county's data to one farm (API: setFarm opts.local)
  // Delta method: every past season's daily weather is shifted by the farm-minus-county difference in NASA POWER's monthly climatology
  // (mean temperature added to Tmax and Tmin, rain scaled by the ratio, ET0 by the same ET_PER_C per degree the sliders use).
  var localClimCache = { base: null, key: '', val: null };
  function localClimate(base, L) {
    var dT = Array.isArray(L.tempC) && L.tempC.length === 12 ? L.tempC.map(function (x) { return clamp(+x || 0, -8, 8); }) : null;
    var rR = Array.isArray(L.rainRatio) && L.rainRatio.length === 12 ? L.rainRatio.map(function (x) { return clamp(+x || 1, 0.4, 2.5); }) : null;
    if (!dT && !rR) return base;
    var key = JSON.stringify([dT, rR]);
    if (localClimCache.base === base && localClimCache.key === key) return localClimCache.val;
    var sc = base.meta.scale, out = { meta: Object.assign({}, base.meta, { local: { tempC: dT, rainRatio: rR } }), seasons: {} };
    Object.keys(base.seasons).forEach(function (y) {
      var S = base.seasons[y], o = {};
      Object.keys(S).forEach(function (k) { o[k] = S[k]; });
      ['tmax', 'tmin', 'rain', 'et0'].forEach(function (k) { o[k] = S[k].slice(); });
      for (var d = 0; d < N_DAYS; d++) {
        var m = CAL.m[d] - 1, t = dT ? dT[m] : 0, r = rR ? rR[m] : 1;
        if (t) { o.tmax[d] = Math.round(S.tmax[d] + t * sc.tmax); o.tmin[d] = Math.round(S.tmin[d] + t * sc.tmin); o.et0[d] = Math.round(S.et0[d] * (1 + ET_PER_C * t)); }
        if (r !== 1) o.rain[d] = Math.round(S.rain[d] * r);
      }
      out.seasons[y] = o;
    });
    localClimCache = { base: base, key: key, val: out };
    return out;
  }
  // The farm's own soil (NRCS at its point), then what the farmer told us: tile drainage, a drainage class that contradicts the survey, worn soil.
  var BETTER_DRAIN = /poorly/i;
  function localSoil(soil, ai) {
    var o = clone(soil || {});
    if (!ai) return o;
    if (ai.drainageClass && ai.drainageClass !== 'keep') { o.surveyDrainage = o.drainage; o.drainage = ai.drainageClass; }
    if (ai.tileDrained && BETTER_DRAIN.test(o.drainage || '')) { o.surveyDrainage = o.surveyDrainage || o.drainage; o.drainage = 'Moderately well drained'; o.tiled = true; }
    var a = clamp(+ai.awcPct || 0, -15, 10);
    if (a && o.awcMmPerM) o.awcMmPerM = Math.round(o.awcMmPerM * (1 + a / 100));
    return o;
  }

  // what the wet-soil text says about tile, depending on the farmer's answer (setFarm opts.local)
  function tileWords() {
    var t = (FS.data.farm.fields || []).some(function (f) { return f.soil && f.soil.tiled; });
    return t ? 'Wet soil uses the soil survey drainage class, moved up to moderately well drained on the fields you said are tile drained; the tile itself is not modelled.'
             : 'Wet soil uses the soil survey drainage class; tile drainage is not modelled.';
  }

  // ---------------------------------------------------------------- next-harvest outlook
  // days: { <season day index>: { tmax, tmin, rain, et0 } } (deg C, mm; null keeps that season's own value).
  // Every past season is replayed twice for each field's current plan: as it was, and with these days put in place of its own.
  // The normal (100%) stays the one measured on the unchanged seasons, so the difference is what the coming days do.
  function outlook(days) {
    var farm = FS.data.farm, base = climate(), c = FS.data.initialControls, sh = shiftOf(c.weather || {}, c.crops), E = FS.data.economics;
    var ref = getRef(farm);
    function dist() {
      var yt = yieldTable(farm, sh);
      return farm.fields.map(function (f) {
        var pid = c.crops.plans[f.id], T = ytPlan(yt, f, pid);
        return { fieldId: f.id, name: f.name, acres: f.acres, plan: pid, planLabel: (FS.data.plans[pid] || {}).label || pid, crop: T.crop, normalBu: E.normalYield[T.crop] || null,
                 bu: Array.prototype.slice.call(T.bu), pct: Array.prototype.slice.call(T.pct) };
      });
    }
    var normal = dist(), idx = Object.keys(days || {}).map(Number).filter(function (d) { return d >= 0 && d < N_DAYS; });
    if (!idx.length) return { years: base.meta.years.slice(), normal: normal, outlook: normal };
    var sc = base.meta.scale, C2 = { meta: base.meta, seasons: {} };
    Object.keys(base.seasons).forEach(function (y) {
      var S = base.seasons[y], o = {};
      Object.keys(S).forEach(function (k) { o[k] = S[k]; });
      ['tmax', 'tmin', 'rain', 'et0'].forEach(function (k) { o[k] = S[k].slice(); });
      idx.forEach(function (d) {
        var v = days[d];
        ['tmax', 'tmin', 'rain', 'et0'].forEach(function (k) { if (v[k] != null && isFinite(v[k])) o[k][d] = Math.round(v[k] * sc[k]); });
        if (o.tmin[d] > o.tmax[d]) o.tmin[d] = o.tmax[d];
      });
      C2.seasons[y] = o;
    });
    var saved = [wxCache, dayCache, planCache, shiftedCache, hybCache, chainCache, yieldCache, refCache], out;
    resetCaches(); REF_LOCK = ref; FS.data.climate = C2;
    try { out = dist(); }
    finally {
      FS.data.climate = base; REF_LOCK = null;
      wxCache = saved[0]; dayCache = saved[1]; planCache = saved[2]; shiftedCache = saved[3]; hybCache = saved[4]; chainCache = saved[5]; yieldCache = saved[6]; refCache = saved[7];
    }
    return { years: base.meta.years.slice(), normal: normal, outlook: out, days: idx.length };
  }

  var POS = { north: 'North', creek: 'Creek', west: 'West', south: 'South' };
  // A whole climate from elsewhere (imported fields: Copernicus reanalysis at the farm), checked before it replaces the county's.
  // The heat calibration stays the county's: it is a property of the crop model, not of the weather source.
  function goodClimate(C, base) {
    if (!C || !C.meta || !C.seasons || !Array.isArray(C.meta.years) || C.meta.years.length < 30) return null;
    var ok = C.meta.years.every(function (y) { var s = C.seasons[y]; return s && ['tmax', 'tmin', 'rain', 'et0'].every(function (k) { return Array.isArray(s[k]) && s[k].length === N_DAYS; }); });
    if (!ok) return null;
    return { meta: Object.assign({}, base.meta, C.meta, { heatMatch: base.meta.heatMatch, scale: Object.assign({}, base.meta.scale, C.meta.scale) }), seasons: C.seasons };
  }
  function goodPoly(p) { return Array.isArray(p) && p.length >= 3 && p.every(function (q) { return Array.isArray(q) && isFinite(q[0]) && isFinite(q[1]); }) ? p.map(function (q) { return [+q[0], +q[1]]; }) : null; }
  function setFarm(opts) {
    opts = opts || {};
    var O = origFarm(), D = FS.data, id = opts.site || 'story-ia', st = null, i;
    (D.sites || []).forEach(function (x) { if (x.id === id) st = x; });
    if (!st && id !== 'story-ia') return { ok: false, error: 'Unknown site: ' + id };
    var isStory = !st || id === 'story-ia';
    var farm = D.farm, req = {};
    (opts.fields || []).forEach(function (x) { if (x && x.id) req[x.id] = x; });
    // imported field outlines (GeoJSON): only those fields, with their own names, shapes and acres, and the climate measured at them
    var G = opts.geo && typeof opts.geo === 'object' && Array.isArray(opts.geo.fields) && opts.geo.fields.length ? opts.geo : null, gf = {};
    if (G) G.fields.forEach(function (x) { if (x && POS[x.id]) gf[x.id] = x; });
    if (G && !Object.keys(gf).length) G = null;
    farm.fields.length = 0;   // in place: the UI holds this array
    // how many fields (1 to 4, opts.count): the first N of the layout; imported outlines bring their own
    var NF = clamp(Math.round(+opts.count) || O.objs.length, 1, O.objs.length);
    O.objs.forEach(function (o, i) { if (G ? gf[o.id] : i < NF) farm.fields.push(o); });
    // site data into the shared objects (in place: the UI holds references)
    D.climate = isStory || !st.climate ? O.climate : st.climate;
    var GC = G ? goodClimate(G.climate, D.climate) : null;
    if (GC) D.climate = GC;
    var L = opts.local && typeof opts.local === 'object' && (opts.local.tempC || opts.local.rainRatio || opts.local.soils || opts.local.normalYield || opts.local.ai) ? opts.local : null;   // a fit with no data is no fit
    if (L) D.climate = localClimate(D.climate, L);
    resetCaches();
    farm.place = isStory ? O.place : st.name;
    farm.lat = isStory ? O.lat : st.lat; farm.lon = isStory ? O.lon : st.lon;
    var soils = {};
    farm.fields.forEach(function (f) { soils[f.id] = isStory ? O.fields.filter(function (x) { return x.id === f.id; })[0].soil : st.soils[f.id]; });
    if (L) farm.fields.forEach(function (f) { soils[f.id] = localSoil(L.soils && L.soils[f.id] && L.soils[f.id].awcMmPerM ? L.soils[f.id] : soils[f.id], L.ai); });
    farm.countyAwcMmPerM = isStory ? O.county : (st.countyAwcMmPerM || Math.round(mean(farm.fields.map(function (f) { return soils[f.id].awcMmPerM || 180; }))));
    var plans = D.initialControls.crops.plans, trial = D.initialControls.crops.trialAcres;
    farm.fields.forEach(function (f) {
      var o = O.fields.filter(function (x) { return x.id === f.id; })[0], r = req[f.id] || {};
      var g = gf[f.id], ac = g && +g.acres > 0 ? clamp(Math.round(+g.acres), 1, 5000) : r.acres == null ? o.acres : clamp(Math.round(+r.acres) || o.acres, 10, 640);
      var lc = g && (g.lastCrop === 'corn' || g.lastCrop === 'soybean') ? g.lastCrop : r.lastCrop === 'corn' || r.lastCrop === 'soybean' ? r.lastCrop : o.lastCrop;
      f.acres = ac; f.lastCrop = lc; f.name = g && g.name ? String(g.name).slice(0, 28) : POS[f.id] + ' ' + ac; f.soil = clone(soils[f.id]);
      f.poly = (g && goodPoly(g.poly)) || clone(o.poly);
      plans[f.id] = lc === 'corn' ? 'soy' : 'corn'; trial[f.id] = ac;
      // optional current plan (for example a cover crop the farmer already plants): only one this field may choose; anything else keeps the default
      if (typeof r.currentPlan === 'string' && (D.planOptions[lc] || []).indexOf(r.currentPlan) >= 0) plans[f.id] = r.currentPlan;
    });
    var ny = D.economics.normalYield;
    ny.corn = isStory ? O.normal.corn : st.normalYield.corn; ny.soybean = isStory ? O.normal.soybean : st.normalYield.soybean;
    if (L) ['corn', 'soybean'].forEach(function (c) {
      var base = L.normalYield && +L.normalYield[c] > 0 ? +L.normalYield[c] : ny[c], adj = L.ai && L.ai.yieldPct ? clamp(+L.ai.yieldPct[c] || 0, -10, 10) : 0;
      ny[c] = Math.round(base * (1 + adj / 100) * 10) / 10;
    });
    if (L && L.label) farm.place = L.label;
    farm.imported = !!G;
    setScenarios(isStory && !GC);
    SITE = isStory ? { id: 'story-ia', name: O.place, short: 'Story Co., IA', state: 'IA', validated: true } : { id: st.id, name: st.name, short: st.short, state: st.state, validated: st.validated !== false && !!st.validated, lat: st.lat, lon: st.lon };
    if (st && isStory) { SITE.name = st.name || SITE.name; SITE.short = st.short || SITE.short; }
    SITE.local = L ? { label: L.label || '', km: L.km, dataFrom: isStory ? 'Story County, Iowa' : st.name, lat: L.lat, lon: L.lon } : null;
    if (L) { SITE.name = L.label || SITE.name; SITE.validated = false; }
    SITE.geo = G ? { fields: farm.fields.length, weather: GC ? (GC.meta.short || 'imported') : null } : null;
    if (G) SITE.validated = false;
    return { ok: true, site: { id: SITE.id, name: SITE.name, short: SITE.short, state: SITE.state, validated: SITE.validated, typicalYear: typicalYear() } };
  }

  // warm: builds every cache the first run needs (reference seasons, season starts, yields of all plan options); returns ms
  function warm(controls) {
    var t = Date.now(), farm = FS.data.farm, c = controls || FS.data.initialControls;
    var r = getRef(farm), yt = yieldTable(farm, shiftOf(c.weather || {}, c.crops));
    farm.fields.forEach(function (f) { yt.opts[f.id].forEach(function (pid) { if (planInfo(pid).cashCrop !== 'oats') ytPlan(yt, f, pid); }); });
    return { totalMs: Date.now() - t, buildMs: r.buildMs };
  }

  // evaluate one field on one plan and season, no controls needed (used by tests and tools)
  function evalYear(fieldId, planId, year, shift, other) {
    var farm = FS.data.farm, f = farm.fields.filter(function (x) { return x.id === fieldId; })[0], ref = getRef(farm);
    var sh = shift ? shiftOf(shift, shift) : NO_SHIFT, o = other || FS.data.initialControls.other;
    if (!other && sh.irr !== 'none') o = otherOf({ other: o, crops: { irrigation: sh.irr } });
    return evalField(farm, f, planId, baseWx(year), sh, o, ref, false, heatOf(), 1);
  }
  FS.engine = { setFarm: setFarm, outlook: outlook, site: function () { return { id: SITE.id, name: SITE.name, short: SITE.short, state: SITE.state, validated: SITE.validated, local: SITE.local || null, geo: SITE.geo || null }; }, run: run, evalYear: evalYear, scenario: scenario, compare: compare, seasons: seasons, warm: warm, sample: false, N_WEEKS: N_WEEKS,
                validation: function () { return VALIDATION; },
                _ref: function () { return getRef(FS.data.farm); }, _setParams: setParams, _components: components, _hybrids: hybrids,
                _irrigation: function () { return { kwhPerAcreInch: IRR_KWH_PER_ACRE_IN, dollarsPerKwh: IRR_DOLLARS_PER_KWH, dollarsPerAcreInch: IRR_COST_PER_ACRE_IN, inches: { july: irrInches('july'), 'july-aug': irrInches('july-aug'), 'jun-aug': irrInches('jun-aug') } }; },
                _const: { FIT: FIT, WARM_LOSS: WARM_LOSS, RISK_K_DEFAULT: RISK_K_DEFAULT } };
})();

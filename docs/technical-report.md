# EcoShift: Replaying Real Weather Seasons to Compare Crop Rotations

**Authors:** Shaurya, Arnav and Ghrini (EcoShift team)
**Project:** 2026 NASA Space Apps Challenge, "Field Shift: Adapting Farms with NASA Data"
**Live tool:** https://ecoshift-final-8dsi.vercel.app/
**Code:** MIT License, see `LICENSE` in the repository
**Status:** Student research report on a working prototype. Every number in this report is copied from the repository documents named beside it. Where this report and a source document differ, the source document is right.

## Contents

1. Abstract
2. Research Question
3. Background
4. Data
5. The Crop Model
6. Validation Methodology
7. Results
8. Multi-County Results
9. Field-Level Satellite Checks
10. AI Design And Safeguards
11. Limitations
12. Future Work
13. References

---

## 1. Abstract

Farmers choose next year's rotation before they know the weather. EcoShift tests that choice by replaying 44 real seasons (1982 to 2025) of NASA POWER daily weather through a FAO-56 soil-water crop model on a farmer's own fields, then comparing rotations in harvest, profit and bad-season risk. Imported field outlines can also be checked from space, with Copernicus Sentinel-2 field health, NASA fire detections, NASA soil wetness and terrain.

We tested the weather response of the model against USDA NASS Iowa state yields for corn and soybeans, 1982 to 2025, predicting each season with the model's settings fitted without that season (leave-one-year-out). For corn, the correlation is r 0.48 and the error is 9.9 points of a normal crop, against 11.3 for a trend-only guess (skill 0.12). The model ranks the 1988 and 2012 droughts among its three lowest seasons. But in ordinary years, with 1988 and 2012 left out, it does no better than the trend (corn r 0.27, error 9.9 against 9.7), and it misses the 1993 flood. A small ridge regression on six weather numbers does better on the same test (corn r 0.58, error 9.1), but it cannot compare rotations, so we kept the process model and say so. NASA MODIS vegetation over Story County tracks real county corn yields (r 0.61), which gives an independent check that the satellite and the model both see 2012. A second test on 14 Corn Belt counties, each against its own USDA county yields with the Iowa settings unchanged, gives a small skill over the trend in 14 of 14 counties for corn and 13 of 14 for soybeans (median 0.14 and 0.11), mostly from the worst seasons and often within the noise. Several limits apply: one weather grid cell per county, no direct validation of rotation or cover-crop effects, and no testing with farmers yet.

## 2. Research Question

> Can historical weather-based crop simulation help farmers evaluate the resilience and financial trade-offs of alternative crop rotations under increasing climate variability?

We split this into three parts we can check:

1. **Does the simulation respond to real weather the way real yields do?** (Validation, sections 6 to 8.)
2. **Can it show resilience, meaning how a rotation does in the worst seasons and not only on average?** (Section 5, "What it compares", and the risk numbers in section 7.)
3. **Does showing this to a farmer help them make a better-informed decision?** We have not tested this yet. A test plan is in `docs/farmer-testing/`. This report does not claim an answer to part 3.

## 3. Background

Rotation choices are made months ahead, and a wrong choice shows only at harvest. We use one example from our own sources. Iowa's 2012 drought gave a state corn yield of 137 bu/acre, against 172 in 2011 (USDA NASS, quoted in `simulator-source/VALIDATION.md`, section 1). In the same document, the 2012 yield is 0.76 of the yield trend. The 2012 season is the main example the tool uses.

We add no other statistics about farm losses or climate change here, because we have not yet put a cited source for them in the repository. The question of "increasing climate variability" is therefore a motivation in this report, not a result. Our model can replay past years that were hot or dry. It does not project future climate (see section 12).

Related methods we build on: the FAO-56 method for crop water use (Allen et al. 1998), the FAO-33 yield response to water (Doorenbos and Kassam 1979), and published planting-date, frost and rotation effects from Iowa State and other extension sources, listed in section 13.

## 4. Data

All raw downloads are kept in `simulator-source/raw/` with their SHA-256 hashes in `simulator-source/raw/HASHES.txt`. Source for this section: `simulator-source/DATA_NOTES.md` unless stated.

| Data | Source, version and resolution | Use |
|---|---|---|
| Daily weather 1981 to 2025 | NASA POWER daily point API v2.10.3, AG community, built from NASA MERRA-2 and CERES SYN1deg. A grid cell about 0.5 x 0.625 degrees (roughly 50 km). Story County point 42.03 N, 93.47 W. Parameters: T2M_MAX, T2M_MIN, T2M, T2MDEW, RH2M, WS2M, ALLSKY_SFC_SW_DWN, PRECTOTCORR, PS, GWETROOT. Pulled 2026-11-14 | Input to every simulated season |
| Reference evapotranspiration | FAO-56 Penman-Monteith computed from POWER (Hargreaves on days without radiation; POWER has no radiation before 1984-01-01, so 776 days of seasons 1982 to 1984 use Hargreaves) | Crop water use |
| Soil | USDA NRCS Soil Data Access, map unit at one point per field (water-holding aws0150wta, drainage class, slope). 14 counties and any imported field | Soil water bucket |
| Yields | USDA NASS Quick Stats: Iowa state corn and soybean 1975 to 2025, Story County, and county yields for the other counties. Pulled 2026-11-15 | Validation; the farm's normal yield |
| Cross-check weather | Open-Meteo ERA5 archive, grid cell snapped to 42.0035, -93.4061 | Explaining misses, backup weather |
| Station frost data | NOAA GHCN-Daily, three stations near Ames (USC00130200, USW00094989, USC00131710) | Checking POWER's cold fall nights |
| Vegetation check | NASA GIBS WMS, `MODIS_Terra_L3_NDVI_16Day`, MODIS Terra 16-day NDVI at 250 m. 345 composites, 2000 to 2025, April to October | Independent check of the weather response |
| Soil wetness | NASA POWER MERRA-2 GWETROOT and GWETTOP (modelled, not SMAP) | Model check and near-real-time wetness |
| Sentinel-2 | Copernicus Sentinel-2 Level-2A through Element 84 Earth Search and the public Cloud Optimized GeoTIFFs on AWS | Field health, burned ground, bare soil |
| Fire | NASA GIBS VIIRS (SNPP, NOAA-20) 375 m and MODIS thermal anomalies layers, read as map PNGs | Fire check |
| Terrain | Copernicus DEM GLO-30 (30 m) | Slope, height, low spots |
| Land cover | ESA WorldCover 2021 (10 m) | Ponds, streams, wetlands |
| Soil fertility outside the US and near real time | ISRIC SoilGrids 250 m | Organic carbon, nitrogen, pH, CEC |
| Live weather | ECMWF IFS, Copernicus ERA5-Land and CAMS through Open-Meteo | Weather now, 30-day outlook |
| Costs and prices | Iowa State University crop budgets (A1-20, January 2026, read through secondary summaries), USDA WASDE November 2026, RMA volatility factors, Iowa cover crop cost-share | Money results |

**Season definition.** Season Y runs from 16 November of the year before to 15 November of Y, with 29 February dropped, so every season has 365 days. There are 44 seasons, 1982 to 2025.

**Known data differences** (`DATA_NOTES.md`): POWER runs warm in hot summers (Tmax tracks ERA5 at about 0.99 correlation, but June to August is warmer); our ET0 is within about 11% of Open-Meteo's ERA5 ET0 for the three check summers (2012 +10.3%, 2019 -11.3%, 2023 +3.9%); POWER and ERA5 disagree on summer rain in several seasons (1983: 335 against 237 mm for June to August).

**Not real or not site-specific:** prices (national, held constant across replayed years), costs (Iowa State budgets), the example farm's field layout and acres (illustrative), and oats cost, price and yield (placeholders with no source).

## 5. The Crop Model

The model is `simulator-source/src/engine.js`. It runs in the browser, makes no network calls, and replays one weather season through each field day by day. Every constant is tagged in the code as **SOURCED** (taken from a cited source), **FITTED** (fitted to USDA yields by `tools/validate.py`) or **DESIGN** (a team choice, not yet checked).

### Water balance (FAO-56)

- A daily soil-water balance over a 1.5 m profile in two layers: the root zone, which deepens as the crop grows, and the soil below it, which is refilled by drainage and taken into the root zone as roots reach it. **SOURCED** structure (FAO-56).
- Reference evapotranspiration is FAO-56 Penman-Monteith from NASA POWER. Crop water use is ET0 x Kc, with Kc mid 1.20 for corn and 1.15 for soybean (FAO-56 Table 12) and the FAO-56 depletion adjustment p = p_tab + 0.04 x (5 - ETc). **SOURCED.**
- A surface evaporation layer (REW 9 mm, TEW 25 mm, FAO-56 Table 19) decides when a field is workable. **SOURCED.**
- Capillary rise from a water table, with a fitted ceiling (6 mm/day times a drainage-class share; 0.7 for the county reference). Iowa State extension reports water tables near 1.5 to 1.8 m at silking. The ceiling is **FITTED**; the drainage-class shares (`WT_SHARE`, `DRAIN_K`) are **DESIGN**.
- Optional irrigation adds 25 mm a week in the chosen months. This is a **DESIGN** assumption and is not validated.

### Growth stages

Stages follow growing degree days. Corn V6 at 475, R1 at 1420, R6 at 2700 (central-Iowa extension tables, **SOURCED**). The hybrid and variety are matched to the location's season length (black layer 14 days before the first -2 C night in 9 of 10 past seasons from a 28 April planting: 2670 GDD, **DESIGN**). Planting waits for a workable field: warm enough, under 5 mm of rain over two days (two workable days in a row), and no hard frost (**DESIGN**). Late planting follows the Iowa State planting-date curve (**SOURCED**) and needs about 6.8 fewer degree days per day of delay (Purdue, **SOURCED**).

### Yield formula

Yield as a percent of a normal crop:

```
Yield % = 100 x (Sw / median Sw)^gamma x (fill / median fill)^eDur x PD x Yf x Yrot x Ycc / norm

Sw   = Yw x Yh x Yww   water stress weighted by stage (FAO-33 Ky, corn flowering 1.50), heat, waterlogging
fill = length of grain fill
PD   = planting-date multiplier (Iowa State)
Yf   = frost (UNL CropWatch stage losses: soft dough 0.45, dent 0.60, half milk line 0.88, black layer 1.0)
Yrot = rotation effect (Iowa State budgets: corn after corn costs 8.5% in the median season)
Ycc  = cereal rye before corn (Iowa State, -4.1%)
norm = the median season of the baseline rotation, so the median season = 100
```

| Part | Tag |
|---|---|
| Water stress structure, Kc, FAO-33 Ky | SOURCED |
| Planting-date curve, frost-stage losses, rotation effect, rye effect | SOURCED |
| gamma, heat slope b, grain-fill exponent eDur | FITTED, per crop, by leave-one-year-out against NASS Iowa yields |
| Rooting depth 1.5 m, fixed season start, capillary ceiling 6 mm/day | FITTED (chosen in each fold) |
| Drainage shares, soybean-after-soybean drag (central 7%, no published source), oats and rye placeholders, electricity price | DESIGN |
| Risk widening factor k (1.57 corn, 2.20 soybean) | CALIBRATION, from `data/validation.json` |
| Warming floor (7.4% per degree C corn, 3.1% soybean; Zhao et al. 2017) | ASSUMPTION from a published average |

Shipped parameters, fitted on all 44 seasons (`VALIDATION.md`, section 3): corn gamma 0.315, heat slope b 0.00000 per degree day, eDur 0.238; soybean gamma 0.462, b 0.00013, eDur 0.000.

**Why gamma is limited to the weather part.** An earlier version applied one fitted exponent to every multiplier, which shrank the sourced management effects about six times (corn after corn cost 0.5 points instead of about 8.5%). Now gamma applies only to Yw x Yh x Yww, and planting date, frost, rotation and cover-crop multipliers are applied after it, uncompressed.

**Heat.** The fitted corn heat slope is 0: heat damage cannot be told apart from water stress in this record. The temperature slider therefore uses a published average floor for warming losses (Zhao et al. 2017, PNAS). This is an assumption, not a result.

### Money and risk

Money comes from Iowa State budgets and national prices, and the farmer can set their own prices. A "too close to call" flag is raised when the sign of the average difference flips under plausible changes in prices or costs, or when the difference is smaller than the weather error band converted to dollars (validation error divided by the square root of 44). The risk numbers (worst five seasons, risk label, risk ranking) widen each season's deviation by k so the model's spread matches the observed Iowa spread.

### What it compares

For each field: corn, soybeans, corn after corn, soybeans after soybeans, cereal rye before corn or soybeans, and oats with a summer cover crop. Each option reports harvest and profit in a typical season (2011, chosen as closest to the median in both June to August rain and May to September growing degree days) and in the worst seasons, how many of the 44 seasons it beat the current plan, the evidence behind it, the extra work and the information gaps.

## 6. Validation Methodology

Source: `simulator-source/VALIDATION.md`, sections 1 to 3.

- **Target.** Yield ratio = NASS yield divided by the technology trend. The trend is a robust straight line (Tukey bisquare) through 1982 to 2025. Inside each fold the trend is refitted without the held-out season.
- **Leave-one-year-out.** 44 folds, one per season. In each fold, on the 43 other seasons, the process model's structural settings (rooting depth 1.2 or 1.5 m; fixed or carried-over season start; capillary ceiling 0, 2, 4 or 6 mm/day) and three numbers (gamma, heat slope b, grain-fill exponent eDur) are chosen by least squares. The held-out season is then predicted.
- **Comparison models.** Trend-only (predicts the trend, a ratio of 1). Ridge regression on six season features from the same POWER cell: June to August rain and its square, July to August hot degree days above the matched 30 C threshold, May to September growing degree days, April to June rain, and July to August MERRA-2 root-zone wetness. Gradient boosting (depth-2 trees, 200 trees, learning rate 0.05) on the same features. Ridge on the process model's own stress indices.
- **Metrics** on the 44 out-of-sample predictions: Pearson r, Spearman r, RMSE in points of the trend, and skill = 1 - RMSE / RMSE(trend-only). Also reported without 1993 (Midwest flood) and 2020 (derecho, wind is not in weather data), and without 2012.
- **Ordinary-year test.** Skill is repeated with 1988 and 2012 left out, so that two drought years cannot carry the score.
- **Bootstrap.** 95% interval for the all-years r, from 5,000 resamples of the 44 seasons.
- **Secondary check.** The same method against Story County NASS yields (the county the POWER cell sits in).
- **Independent satellite check.** MODIS vegetation against county yields and against the model (section 9).
- **Frost check.** POWER and ERA5 fall nights compared with three NOAA GHCN-Daily stations (section 11).
- **Reproducibility.** `python3 tools/validate_fetch_nass.py`, then `python3 tools/validate.py --write`, then `node --test tests/engine.test.js`. The check takes about 2 minutes.

An independent audit (round 3, summarised in `VALIDATION.md` section 8; the audit file it names is not in this repository) reproduced the numbers and found that our earlier headline was stronger than the evidence. We rewrote the headline. Details of what that audit changed are in the portfolio, `docs/portfolio.md`.

## 7. Results

Numbers in this section are copied from `simulator-source/VALIDATION.md` (sections 3, 7, 8 and 11).

### Corn, Iowa state yields, leave-one-year-out, 44 seasons 1982 to 2025

| Model | Pearson r | Spearman r | RMSE (points of trend) | Skill vs trend-only |
|---|---|---|---|---|
| Process model (this simulator) | 0.48 | 0.24 | 9.9 | 0.12 |
| Ridge regression on 6 POWER season features | 0.58 | 0.56 | 9.1 | 0.20 |
| Gradient boosting (depth-2 trees) | 0.20 | 0.23 | 11.9 | -0.06 |
| Ridge on the process model's stress indices | -0.20 | -0.09 | 13.3 | -0.18 |
| Trend only | - | - | 11.3 | 0 |

### Soybean, same test

| Model | Pearson r | Spearman r | RMSE (points of trend) | Skill vs trend-only |
|---|---|---|---|---|
| Process model | 0.27 | 0.05 | 9.5 | 0.04 |
| Ridge regression on 6 POWER season features | 0.55 | 0.59 | 8.2 | 0.16 |
| Gradient boosting | 0.40 | 0.37 | 9.1 | 0.08 |
| Ridge on the process model's stress indices | -0.13 | -0.12 | 10.0 | -0.02 |
| Trend only | - | - | 9.8 | 0 |

### What the numbers show

- **The big droughts.** The process model ranks 1988 and 2012 among its three lowest seasons for both crops, scored without ever seeing those years. For corn: 1988 observed 0.67 against 0.80 predicted; 2012 observed 0.76 against 0.80 predicted (`VALIDATION.md`, section 3 table). The model's drops are shallower than the real ones, so it understates how bad the worst years were.
- **Ordinary years.** With 1988 and 2012 left out (42 seasons), corn process r 0.27, RMSE 9.9 against 9.7 for trend-only (skill -0.02). Also without 1993 and 2020 (40 seasons): r -0.01, RMSE 9.2 against 7.4 (skill -0.26). Soybean, 1988 and 2012 left out: r -0.06, RMSE 9.6 against 9.2 (skill -0.05). **Outside the two droughts the model has no skill.** The skill it has comes from the big droughts.
- **Uncertainty.** Bootstrap 95% interval for the all-years r: corn [-0.02, 0.78], soybean [-0.20, 0.59]. Neither clearly excludes zero.
- **The 1993 flood miss.** 1993 observed corn ratio 0.59 (80 bu/acre), predicted 0.84. The 1993 loss came from flooding, waterlogging, late planting, nitrogen loss and hail, which a bucket model of weather does not capture. We show it as "not a weather-model year". Without 1993 and 2020, corn skill is about 0 (-0.01 stated in `VALIDATION.md` section 7).
- **Other misses.** 1992 stays low in the model (77 to 82%) because of slow corn development in a cool summer. The 18 October 1992 freeze is real at the stations (-4.4 and -5.6 C). 1983 is missed because POWER and ERA5 disagree about summer rain. 2017 and 2021 (record yields) now come out 0.95 and 0.94 of trend out of sample, against 1.06 and 1.02 real, and rank 10th and 9th lowest instead of 4th and 3rd after the two-layer profile and capillary rise were added.
- **Story County.** Corn r 0.28, RMSE 12.6 against 12.8 for trend-only (skill 0.02). Soybean r 0.26, RMSE 12.8 against 13.1 (skill 0.02). The county yields are noisier, and the model has almost no skill on them.
- **Spread.** Corn observed sd 11.2 points, predicted 7.1 (k = 1.56 in section 3 of `VALIDATION.md`, 1.57 in its section 8). Soybean observed sd 9.8, predicted 4.4 (k = 2.20). The mean of the 5 worst seasons was observed 0.73, predicted 0.82 (corn); observed 0.77, predicted 0.89 (soybean). We widen the risk numbers by k for this reason.
- **Typical error in dollars.** One season's typical error is about $96 per acre for corn and $70 for soybean at today's prices, and about $15 and $11 per acre for a 44-season average.

### Ridge compared with the process model

The six-feature ridge beat the process model for both crops (corn r 0.58 against 0.48, RMSE 9.1 against 9.9; soybean r 0.55 against 0.27, RMSE 8.2 against 9.5). Gradient boosting was worse than both for corn. The build plan said in advance that if the process model lost to ridge, ridge would become the yield engine. We did not switch, and `VALIDATION.md` calls this a deviation from the pre-registered rule. Reasons: ridge maps six season totals of state weather to state yield for one rotation, so it cannot evaluate a rotation, a cover crop, a planting date, a frost date or a temperature shift, which are what the tool exists to compare; and its advantage (about 1 to 3 points of RMSE) is small and uncertain given the bootstrap intervals. The cost is that the weather part of the tool is not a better predictor than the trend outside droughts, and the screen says so.

### Satellite result

NASA MODIS Terra NDVI over Story County cropland, 2000 to 2025 (26 seasons), tracks NASS Story County corn yields with r 0.61 (0.56 Spearman; 0.57 without 2012), which makes it a useful independent signal. The model agrees with the satellite only weakly (corn r 0.37 for all years, 0.15 without 2012), and outside 2012 not at all for soybean (r -0.03). With n = 26, an r below about 0.39 cannot be told from zero at the 5% level. In 2012 the satellite peak greenness was 94% of average, the model's corn yield 84% of normal, and NASS Story corn 88% of trend (Iowa 77%). The 2012 curve peaked early (11 July) and fell fast in August. All three show 2012 as a bad year, but the model's drop is deeper than the satellite's. Source: `VALIDATION.md` section 11, script `tools/satellite_check.py`.

### Development-set caution

The model design was iterated against these same 44 NASS years (the two-layer profile and water-table term were added because 2017 and 2021 ranked as disasters; the frost table, typical-year definition, hybrid matching and planting rule were changed after looking at per-year results). Only the three fitted numbers and the small structural grid are refitted in each fold. Smaller leaks: the hybrid maturity match and the reference medians use all 44 seasons, and soybean's structural setting is chosen with the corn fit. **Treat all numbers as in-sample-ish**, as `VALIDATION.md` section 8 says.

## 8. Multi-County Results

Source: `simulator-source/data/validation_counties.json` and the section "Multi-County Validation (14 Counties)" in `simulator-source/VALIDATION.md`, produced by `python3 tools/validate_counties.py`. Each county is scored against its own USDA NASS county yields, 41 to 44 seasons from 1982 to 2025, with its own NASA POWER weather and NRCS soil. The target and the trend-only baseline are the same as in section 6 (yield as a share of a robust trend, refitted without the held-out season).

Two tests were run:

- **Transfer.** The model exactly as fitted on Iowa state yields, with nothing refitted.
- **Refit.** Leave-one-year-out, refitting the three fitted numbers (gamma, heat slope, grain-fill exponent) on each county's other seasons. The structural settings were not searched again per county.

Transfer test (skill = 1 - model RMSE / trend-only RMSE; RMSE in points of trend):

| County | State | Corn seasons | Corn r | Corn RMSE | Corn trend-only RMSE | Corn skill | Soybean r | Soybean skill |
|---|---|---|---|---|---|---|---|---|
| Dane County | WI | 44 | 0.72 | 8.4 | 11.9 | +0.29 | 0.59 | +0.16 |
| Champaign County | IL | 42 | 0.69 | 12.7 | 16.0 | +0.21 | 0.48 | +0.12 |
| Saunders County | NE | 42 | 0.59 | 11.1 | 13.7 | +0.19 | 0.52 | +0.14 |
| O'Brien County | IA | 44 | 0.58 | 8.4 | 10.3 | +0.18 | 0.07 | -0.05 |
| Saline County | MO | 42 | 0.69 | 13.6 | 16.7 | +0.18 | 0.56 | +0.15 |
| Blue Earth County | MN | 44 | 0.56 | 9.8 | 11.6 | +0.16 | 0.28 | +0.03 |
| Nemaha County | KS | 41 | 0.63 | 25.8 | 30.1 | +0.14 | 0.60 | +0.13 |
| Brookings County | SD | 43 | 0.52 | 13.1 | 14.9 | +0.13 | 0.31 | +0.02 |
| Lenawee County | MI | 44 | 0.45 | 12.2 | 13.7 | +0.11 | 0.54 | +0.14 |
| Story County | IA | 44 | 0.40 | 11.7 | 12.8 | +0.08 | 0.42 | +0.09 |
| Cass County | ND | 44 | 0.42 | 15.8 | 17.2 | +0.08 | 0.50 | +0.13 |
| Wood County | OH | 43 | 0.42 | 12.8 | 13.8 | +0.07 | 0.36 | +0.07 |
| Tippecanoe County | IN | 43 | 0.35 | 14.6 | 15.6 | +0.06 | 0.47 | +0.10 |
| Christian County | KY | 44 | 0.67 | 18.9 | 20.1 | +0.06 | 0.10 | +0.01 |

Soybean season counts differ slightly from corn in a few counties; `VALIDATION.md` lists them.

What the numbers show:

1. **Skill above trend, but small.** Skill is above zero in 14 of 14 counties for corn (median +0.14) and 13 of 14 for soybeans (median +0.11). It is 0.10 or more in 9 counties for corn and 8 for soybeans, and the 95% bootstrap interval stays above zero in only 6 (corn) and 5 (soybean).
2. **Story County is not unusually good.** Its transfer skill (+0.08 corn, +0.09 soybean) is below the median, and its intervals include zero. The state-level result in section 7 (corn skill 0.12) uses Iowa state yields, which are smoother than one county's.
3. **The skill comes from the bad seasons.** Without each county's five worst real seasons, skill is zero or negative in 8 of 14 counties for corn and 7 of 14 for soybeans. On average the model puts 2.6 (corn) and 2.0 (soybean) of a county's five worst seasons in its own worst five, against about 0.6 by chance. Its season-to-season swings are about half the real ones (7.3 vs 15.7 points for corn, 5.1 vs 14.8 for soybeans).
4. **Where it does poorly.** O'Brien County, Iowa, soybeans are worse than trend-only (-0.05). Christian County, Kentucky, is nearly flat in the model, and it misses 2012 there (real 38% of trend, model 95%). The 1993 flood is read as a normal or good season in Nemaha, Saunders and Wood counties. 1992 is predicted badly in both directions: too low in Wood, Tippecanoe, Lenawee and Story, too high in Cass and Brookings. Northern counties and the poorly drained clay of Wood County have wide intervals and little skill.
5. **Refitting does not rescue it.** Median refit skill is +0.15 (corn) and +0.08 (soybean), against +0.14 and +0.11 for the transfer test. Refitting helps most in Christian County corn (+0.06 to +0.39).

These numbers flatter the model somewhat. The Iowa fit used the same 1982 to 2025 seasons, so the shared regional droughts are not unseen years, and the county median used to scale the model includes the held-out season. Our claim stays the same after this test: EcoShift can show which seasons are risky for a plan, and it is not a yield forecast.

## 9. Field-Level Satellite Checks

These checks run on a farmer's imported field outlines through the live server. They are **evidence that the pipeline works and gives plausible output**. They are not validation against measured field truth, and we label each with its evidence level.

| Check | What was done | Evidence level |
|---|---|---|
| Field health from Sentinel-2 | `/api/fieldhealth` on the three Iowa sample fields (Home quarter, Creek bottom, East forty), 16 November 2026. Output health index 88 (Home quarter, harvested), 77 (Creek bottom, harvested) and 60 (East forty, past peak and maturing). Saved in `docs/evidence/field-health-iowa-nasa-2026-11-16.json` | **Plausible output, not checked against harvests.** The indices are rules on published indices (NDVI, NDRE, NDMI, red-edge position), not a model trained on yields. The bushel guide is labelled "a rough guide, not yet checked against real harvests": county normal x (0.55 + 0.5 x health index / 100) with a design range of 0.85 to 1.15 times |
| Burned ground, Patiala, Punjab | Two Sentinel-2 images compared by the burn ratio (NBR at least 0.15 before, below -0.10 now, dNBR drop of at least 0.27, near-infrared below 0.17), then each warning checked against NASA fire detections. Result: four patches of about 6 to 8 acres, with NASA MODIS fire on 3 and 5 November 2026. Saved in `docs/evidence/burn-check-nasa-2026-11-16.json` | **Detected and confirmed by an independent NASA product in one test region.** One region and one date. Not a measured accuracy, no false-positive rate. Bare soil after harvest can pass the burn test, so a warning without NASA fire is labelled "possible burned ground or bare soil after harvest, check on the ground" |
| Terrain from Copernicus GLO-30 | Slope, height and low spots averaged over every 30 m cell inside each outline | Reads a public data set at the field's own cells. Not compared with a survey |
| Weather at an imported field | NASA POWER at the field's grid cell, checked against built-in Story County data: 869 mm against 867 mm of seasonal rain, and the same ET0 | A consistency check for one location |
| Soil wetness | NASA POWER MERRA-2 root-zone and topsoil wetness against the 2001 to 2025 normal for the same two weeks | Modelled, not measured, and not SMAP |

Sentinel-2 reflectance follows processing baseline 04.00 (the -1000 offset after January 2022, honouring `earthsearch:boa_offset_applied`). The red-edge nitrogen check cannot see a field that is short everywhere, so nitrogen advice says to confirm with a soil nitrate or tissue test. Phosphorus cannot be read from orbit, so the page asks for a soil test.

**What we have not done:** compare field health with measured yield on real fields, or measure the burn detector's accuracy across seasons and regions.

## 10. AI Design And Safeguards

EcoShift uses Google Gemini for four optional helpers: the Farm-Fit Helper (reads the farmer's answers about drainage, tiles and slope), the Chat Assistant's fallback path, the Outlook Explainer (turns 30-day forecast numbers into a short note), and the Translator. The other six helpers are plain code. Source: `README.md`, "The Ten Helpers".

Design rules:

1. **The AI never calculates a number.** Every harvest and dollar figure comes from the crop model. Gemini only proposes settings, wording or translations.
2. **A closed list of settings.** Gemini answers to a JSON schema and may only propose settings from a fixed list. The browser clamps out-of-range values and rejects anything else.
3. **Capped changes in code.** The Farm-Fit Helper can change soil water-holding by -15% to +10% and the normal harvest by up to +/-10%, and these caps are enforced in code, not in the prompt.
4. **Rules first.** The chat first tries plain rules that turn known what-ifs into simulator actions (`chat.js`). Only questions the rules do not understand go to Gemini.
5. **Visible trace.** Under every chat answer, "How This Answer Was Made" lists the helpers that ran (for example Chat Rules, Crop Model, Analysis), so the farmer can see which part was code and which was AI.
6. **Honest accuracy.** The prompts carry the validation facts, so the chat states the model's real accuracy instead of overclaiming.
7. **Works without AI.** Without a key, the rule chat, the model and every non-AI feature work the same, and the farmer is told in plain words.
8. **Limits.** Per-visitor rate limits on every AI route, plus a total of 600 AI calls per 10 minutes. Request bodies are size-capped and secrets and server files are never served.
9. **Tested.** 264 chat cases (including the 35 published in `verify/chat_rules.json`) pass, as listed in the README's Tests section (264 of 264).

What we have not done: measure how often Gemini proposes something the code has to reject, or test whether farmers over-trust the AI text. Translation quality has not been checked by native speakers.

## 11. Limitations

All of these are stated in the repository documents. We list them together here.

**Model and validation**
1. **One grid cell against a whole state.** The weather is one POWER cell (about 50 km) in Story County. The yields are Iowa state averages. Drought patches elsewhere in Iowa are in the yields but not in the weather.
2. **No skill outside the big droughts.** Corn r 0.27 and no better than trend (RMSE 9.9 against 9.7) with 1988 and 2012 left out. Soybean r -0.06.
3. **Wide uncertainty.** Bootstrap intervals for r include zero for both crops.
4. **Development-set performance, not a clean test.** The model design was iterated on the same 44 years.
5. **Parameters.** Three fitted numbers per crop plus three structural choices on 44 seasons. Leave-one-year-out refits all of them in every fold.
6. **The model's spread is narrower than Iowa's.** Standard deviation 7.1 against 11.2 points (corn) and 4.4 against 9.8 (soybean), corrected for the risk numbers by a widening factor that is a calibration, not a mechanism.
7. **Not weather-model years.** 1993 (flood) and 2020 (derecho) are outside what the model can represent.
8. **Technology trend.** Hybrids now tolerate drought better than in 1988, so old droughts replayed with today's hybrids are probably too severe in the model and the yields alike.
9. **Heat is not identifiable.** The fitted corn heat slope is 0. The temperature slider uses a published-average floor (Zhao et al. 2017), which is a different place and model. POWER summer Tmax runs 1 to 3 C hotter than ERA5, which the data cannot separate from a real heat effect. A heat wave event raises water use only, and is probably too mild.
10. **What is not validated:** field-level yields, rotation effects, cover-crop effects and planting-date effects (these come from Iowa State trials and budgets), money, irrigation, the planting shift control and weather events, and, outside the main Iowa test, any county beyond the 14 in section 8 (those 14 have a weaker, separate check).
11. **Soil.** One NRCS map unit at one point per field, which can miss other map units in a real outline. Tile drainage, common in Story County, is not modelled. Drainage differences come from design constants.
12. **Data differences.** POWER and ERA5 disagree on summer rain, summer heat and fall frost. Three NOAA stations agree with POWER on fall frost, not ERA5.
13. **No nitrogen loss, hail, wind, disease or pests.** Only weather, soil water, planting date, frost, rotation and cover crop effects are in the yield formula.

**Money**
14. **Prices are held constant across replayed years.** In real drought years prices rise, so fixed prices overstate drought losses (`DATA_NOTES.md`).
15. **Costs are Iowa State budgets read through secondary summaries**, not the A1-20 PDF itself. Several figures conflict between sources. The N rate for corn after corn (190 lb) is a working number. Oats cost, price and yield and the rye seeding cost ($37) are placeholders with no source.
16. **Cost-share is one-time.** It counts in full in "this season" and once in the 44-season average.

**Satellite and field checks**
17. **Field health bushel guide** is a rough guide with a design range, not a measured error.
18. **NDVI is greenness, not yield.** It saturates near 0.85 to 0.9 and cannot see grain fill or heat at flowering. The MODIS check used a colourised PNG decoded to 0.005 bins, no cloud mask of our own, and a hand-built cropland mask that keeps 84% of the box and includes some grass and woodland. 26 seasons make every r uncertain by about 0.3.
19. **Burn check evidence is one region and one date.** No measured accuracy.
20. **Soil wetness is modelled MERRA-2, not SMAP.**

**Reach and use**
21. **Only a small number of counties.** There are 14 built-in counties. Each now has a check against its own USDA yields (section 8), but the model was fitted on Iowa only, and its skill outside the worst seasons is close to zero in about half of them. Christian County, Kentucky reuses Story County's heat thresholds, because its ERA5 series was not fetched.
22. **No farmer testing yet.** We have not shown that the tool improves a decision. A plan is in `docs/farmer-testing/`.
23. **Performance on hosting.** A cold field import takes about 30 seconds. New farm maps need Python, which the Vercel function does not have.
24. **A prototype.** Results are estimates for comparing options, not predictions, and planting decisions should be confirmed with local agronomic advice.

## 12. Future Work

- **Multi-county calibration.** Validate and, where the data allow, fit the model per county rather than one cell, using county NASS yields. If more counties are added, replace the weather part of the process model with ridge predictions, as `VALIDATION.md` section 6 suggests. See section 8.
- **Climate scenarios.** Today the tool replays past seasons and offers shifts of temperature and rain. We want to test projected daily weather (downscaled climate model output) and see how the ranking of rotations changes, which would address "increasing climate variability" directly.
- **Soil-health evidence.** The cover-crop and rotation effects come from Iowa State budgets and trials. We want field trial or long-term experiment data to validate them, and a clearer soil-health measure beyond months with living roots.
- **Financial risk.** Link prices to weather (drought raises prices), use crop insurance and revenue protection, and model price risk beyond the fixed price assumption.
- **Farmer pilots.** Run the structured tests in `docs/farmer-testing/` with 5 to 8 farmers and 1 to 2 extension specialists, measure task success and whether decisions change, and publish what we change because of them.
- **Field-level validation.** Compare Sentinel-2 field health with measured yields and the burn check with ground reports, and measure false positives.
- **Heat and tile drainage.** Find data in which heat damage can be separated from water stress, and add tile drainage.

## 13. References

Data and tools

- NASA POWER, NASA Langley Research Center. Daily API. https://power.larc.nasa.gov/ and https://power.larc.nasa.gov/docs/services/api/temporal/
- NASA GIBS, NASA EOSDIS. MODIS Terra L3 NDVI 16-day, VIIRS and MODIS thermal anomalies. https://gibs.earthdata.nasa.gov/
- Copernicus Sentinel-2 Level-2A, ESA, through Element 84 Earth Search on AWS.
- Copernicus DEM GLO-30, ESA, public AWS bucket.
- ESA WorldCover 2021 (CC BY 4.0).
- ECMWF, Copernicus ERA5 and ERA5-Land and CAMS through Open-Meteo. https://open-meteo.com/en/docs/historical-weather-api
- USDA NRCS Soil Data Access. https://sdmdataaccess.sc.egov.usda.gov/WebServiceHelp.aspx
- USDA NASS Quick Stats. https://quickstats.nass.usda.gov/
- NOAA GHCN-Daily, public AWS copy. https://noaa-ghcn-pds.s3.amazonaws.com/
- ISRIC SoilGrids (CC BY 4.0).
- Iowa State University Extension, crop budgets A1-20. https://www.extension.iastate.edu/agdm/crops/pdf/a1-20.pdf
- USDA WASDE, November 2026. https://esmis.nal.usda.gov/sites/default/release-files/796142/wasde1126.pdf
- farmdoc daily, projected prices and volatility factors for 2026. https://farmdocdaily.illinois.edu/2026/03/projected-prices-and-volatility-factors-for-2026.html
- Iowa Department of Agriculture and Land Stewardship, cover crop cost-share. https://iowaagriculture.gov/news/cover-crop-cost-share-program-2026

Methods

- Allen, R. G., Pereira, L. S., Raes, D. and Smith, M. (1998). Crop evapotranspiration, FAO Irrigation and Drainage Paper 56. https://www.fao.org/4/x0490e/x0490e0e.htm
- Doorenbos, J. and Kassam, A. H. (1979). Yield response to water, FAO Irrigation and Drainage Paper 33. https://fao.org/4/i2800e/i2800e02.pdf
- Frampton, W. J. et al. (2013). Evaluating the capabilities of Sentinel-2 for quantitative estimation of biophysical variables in vegetation. ISPRS Journal of Photogrammetry and Remote Sensing (red-edge position, cited in the README).
- Zhao, C. et al. (2017). Temperature increase reduces global yields of major crops in four independent estimates. PNAS 114:9326.
- Lobell, D. B. et al. (2013). The critical role of extreme heat for maize production in the United States. Nature Climate Change.
- Zhu et al. (2018), on longer grain fill raising Midwest maize yield, as cited in `VALIDATION.md` section 4 (we have not listed the full reference there, so check it before quoting).
- University of Nebraska-Lincoln CropWatch, frost stage losses; Purdue, late-planting degree days; Iowa State planting-date trials (cited in `engine.js` and `VALIDATION.md`).
- Brooke, J. (1996). SUS: a "quick and dirty" usability scale (for the farmer testing plan).

Our documents

- `simulator-source/VALIDATION.md`, `simulator-source/DATA_NOTES.md`, `simulator-source/README-simulator.md`
- `docs/evidence/` (saved live-check responses), `docs/farmer-testing/`, `docs/portfolio.md`
- `README.md` and the live site, https://ecoshift-final-8dsi.vercel.app/

/**
 * ISO 3166-1 alpha-3 → alpha-2 country code table (complete, 249 entries).
 *
 * Why this exists: the Contest API carries countries as alpha-3
 * (DOMjudge `organization.country` / `team.nationality`), while the flag SVG
 * assets are keyed by alpha-2. The previous 5-entry map with a
 * `slice(0, 2)` fallback produced wrong flags for exactly the countries an
 * ICPC Asia regional sees: BGD→"BG" (Bulgaria, not Bangladesh),
 * BRN→"BR" (Brazil, not Brunei), MAC→"MA" (Morocco, not Macao).
 *
 * GENERATED — do not hand-edit entries. Source of truth:
 * https://raw.githubusercontent.com/lukes/ISO-3166-Countries-with-Regional-Codes/master/all/all.csv
 * (columns `alpha-3` → `alpha-2`, sorted by alpha-3). Regenerate by mapping
 * that CSV; the trailing comment on each line is the ISO short name.
 */

/** Complete ISO 3166-1 alpha-3 → alpha-2. Keys and values are uppercase. */
export const ISO3166_ALPHA3_TO_ALPHA2: Readonly<Record<string, string>> = Object.freeze({
  ABW: 'AW', // Aruba
  AFG: 'AF', // Afghanistan
  AGO: 'AO', // Angola
  AIA: 'AI', // Anguilla
  ALA: 'AX', // Åland Islands
  ALB: 'AL', // Albania
  AND: 'AD', // Andorra
  ARE: 'AE', // United Arab Emirates
  ARG: 'AR', // Argentina
  ARM: 'AM', // Armenia
  ASM: 'AS', // American Samoa
  ATA: 'AQ', // Antarctica
  ATF: 'TF', // French Southern Territories
  ATG: 'AG', // Antigua and Barbuda
  AUS: 'AU', // Australia
  AUT: 'AT', // Austria
  AZE: 'AZ', // Azerbaijan
  BDI: 'BI', // Burundi
  BEL: 'BE', // Belgium
  BEN: 'BJ', // Benin
  BES: 'BQ', // Bonaire, Sint Eustatius and Saba
  BFA: 'BF', // Burkina Faso
  BGD: 'BD', // Bangladesh
  BGR: 'BG', // Bulgaria
  BHR: 'BH', // Bahrain
  BHS: 'BS', // Bahamas
  BIH: 'BA', // Bosnia and Herzegovina
  BLM: 'BL', // Saint Barthélemy
  BLR: 'BY', // Belarus
  BLZ: 'BZ', // Belize
  BMU: 'BM', // Bermuda
  BOL: 'BO', // Bolivia, Plurinational State of
  BRA: 'BR', // Brazil
  BRB: 'BB', // Barbados
  BRN: 'BN', // Brunei Darussalam
  BTN: 'BT', // Bhutan
  BVT: 'BV', // Bouvet Island
  BWA: 'BW', // Botswana
  CAF: 'CF', // Central African Republic
  CAN: 'CA', // Canada
  CCK: 'CC', // Cocos (Keeling) Islands
  CHE: 'CH', // Switzerland
  CHL: 'CL', // Chile
  CHN: 'CN', // China
  CIV: 'CI', // Côte d'Ivoire
  CMR: 'CM', // Cameroon
  COD: 'CD', // Congo, Democratic Republic of the
  COG: 'CG', // Congo
  COK: 'CK', // Cook Islands
  COL: 'CO', // Colombia
  COM: 'KM', // Comoros
  CPV: 'CV', // Cabo Verde
  CRI: 'CR', // Costa Rica
  CUB: 'CU', // Cuba
  CUW: 'CW', // Curaçao
  CXR: 'CX', // Christmas Island
  CYM: 'KY', // Cayman Islands
  CYP: 'CY', // Cyprus
  CZE: 'CZ', // Czechia
  DEU: 'DE', // Germany
  DJI: 'DJ', // Djibouti
  DMA: 'DM', // Dominica
  DNK: 'DK', // Denmark
  DOM: 'DO', // Dominican Republic
  DZA: 'DZ', // Algeria
  ECU: 'EC', // Ecuador
  EGY: 'EG', // Egypt
  ERI: 'ER', // Eritrea
  ESH: 'EH', // Western Sahara
  ESP: 'ES', // Spain
  EST: 'EE', // Estonia
  ETH: 'ET', // Ethiopia
  FIN: 'FI', // Finland
  FJI: 'FJ', // Fiji
  FLK: 'FK', // Falkland Islands (Malvinas)
  FRA: 'FR', // France
  FRO: 'FO', // Faroe Islands
  FSM: 'FM', // Micronesia, Federated States of
  GAB: 'GA', // Gabon
  GBR: 'GB', // United Kingdom of Great Britain and Northern Ireland
  GEO: 'GE', // Georgia
  GGY: 'GG', // Guernsey
  GHA: 'GH', // Ghana
  GIB: 'GI', // Gibraltar
  GIN: 'GN', // Guinea
  GLP: 'GP', // Guadeloupe
  GMB: 'GM', // Gambia
  GNB: 'GW', // Guinea-Bissau
  GNQ: 'GQ', // Equatorial Guinea
  GRC: 'GR', // Greece
  GRD: 'GD', // Grenada
  GRL: 'GL', // Greenland
  GTM: 'GT', // Guatemala
  GUF: 'GF', // French Guiana
  GUM: 'GU', // Guam
  GUY: 'GY', // Guyana
  HKG: 'HK', // Hong Kong
  HMD: 'HM', // Heard Island and McDonald Islands
  HND: 'HN', // Honduras
  HRV: 'HR', // Croatia
  HTI: 'HT', // Haiti
  HUN: 'HU', // Hungary
  IDN: 'ID', // Indonesia
  IMN: 'IM', // Isle of Man
  IND: 'IN', // India
  IOT: 'IO', // British Indian Ocean Territory
  IRL: 'IE', // Ireland
  IRN: 'IR', // Iran, Islamic Republic of
  IRQ: 'IQ', // Iraq
  ISL: 'IS', // Iceland
  ISR: 'IL', // Israel
  ITA: 'IT', // Italy
  JAM: 'JM', // Jamaica
  JEY: 'JE', // Jersey
  JOR: 'JO', // Jordan
  JPN: 'JP', // Japan
  KAZ: 'KZ', // Kazakhstan
  KEN: 'KE', // Kenya
  KGZ: 'KG', // Kyrgyzstan
  KHM: 'KH', // Cambodia
  KIR: 'KI', // Kiribati
  KNA: 'KN', // Saint Kitts and Nevis
  KOR: 'KR', // Korea, Republic of
  KWT: 'KW', // Kuwait
  LAO: 'LA', // Lao People's Democratic Republic
  LBN: 'LB', // Lebanon
  LBR: 'LR', // Liberia
  LBY: 'LY', // Libya
  LCA: 'LC', // Saint Lucia
  LIE: 'LI', // Liechtenstein
  LKA: 'LK', // Sri Lanka
  LSO: 'LS', // Lesotho
  LTU: 'LT', // Lithuania
  LUX: 'LU', // Luxembourg
  LVA: 'LV', // Latvia
  MAC: 'MO', // Macao
  MAF: 'MF', // Saint Martin (French part)
  MAR: 'MA', // Morocco
  MCO: 'MC', // Monaco
  MDA: 'MD', // Moldova, Republic of
  MDG: 'MG', // Madagascar
  MDV: 'MV', // Maldives
  MEX: 'MX', // Mexico
  MHL: 'MH', // Marshall Islands
  MKD: 'MK', // North Macedonia
  MLI: 'ML', // Mali
  MLT: 'MT', // Malta
  MMR: 'MM', // Myanmar
  MNE: 'ME', // Montenegro
  MNG: 'MN', // Mongolia
  MNP: 'MP', // Northern Mariana Islands
  MOZ: 'MZ', // Mozambique
  MRT: 'MR', // Mauritania
  MSR: 'MS', // Montserrat
  MTQ: 'MQ', // Martinique
  MUS: 'MU', // Mauritius
  MWI: 'MW', // Malawi
  MYS: 'MY', // Malaysia
  MYT: 'YT', // Mayotte
  NAM: 'NA', // Namibia
  NCL: 'NC', // New Caledonia
  NER: 'NE', // Niger
  NFK: 'NF', // Norfolk Island
  NGA: 'NG', // Nigeria
  NIC: 'NI', // Nicaragua
  NIU: 'NU', // Niue
  NLD: 'NL', // Netherlands, Kingdom of the
  NOR: 'NO', // Norway
  NPL: 'NP', // Nepal
  NRU: 'NR', // Nauru
  NZL: 'NZ', // New Zealand
  OMN: 'OM', // Oman
  PAK: 'PK', // Pakistan
  PAN: 'PA', // Panama
  PCN: 'PN', // Pitcairn
  PER: 'PE', // Peru
  PHL: 'PH', // Philippines
  PLW: 'PW', // Palau
  PNG: 'PG', // Papua New Guinea
  POL: 'PL', // Poland
  PRI: 'PR', // Puerto Rico
  PRK: 'KP', // Korea, Democratic People's Republic of
  PRT: 'PT', // Portugal
  PRY: 'PY', // Paraguay
  PSE: 'PS', // Palestine, State of
  PYF: 'PF', // French Polynesia
  QAT: 'QA', // Qatar
  REU: 'RE', // Réunion
  ROU: 'RO', // Romania
  RUS: 'RU', // Russian Federation
  RWA: 'RW', // Rwanda
  SAU: 'SA', // Saudi Arabia
  SDN: 'SD', // Sudan
  SEN: 'SN', // Senegal
  SGP: 'SG', // Singapore
  SGS: 'GS', // South Georgia and the South Sandwich Islands
  SHN: 'SH', // Saint Helena, Ascension and Tristan da Cunha
  SJM: 'SJ', // Svalbard and Jan Mayen
  SLB: 'SB', // Solomon Islands
  SLE: 'SL', // Sierra Leone
  SLV: 'SV', // El Salvador
  SMR: 'SM', // San Marino
  SOM: 'SO', // Somalia
  SPM: 'PM', // Saint Pierre and Miquelon
  SRB: 'RS', // Serbia
  SSD: 'SS', // South Sudan
  STP: 'ST', // Sao Tome and Principe
  SUR: 'SR', // Suriname
  SVK: 'SK', // Slovakia
  SVN: 'SI', // Slovenia
  SWE: 'SE', // Sweden
  SWZ: 'SZ', // Eswatini
  SXM: 'SX', // Sint Maarten (Dutch part)
  SYC: 'SC', // Seychelles
  SYR: 'SY', // Syrian Arab Republic
  TCA: 'TC', // Turks and Caicos Islands
  TCD: 'TD', // Chad
  TGO: 'TG', // Togo
  THA: 'TH', // Thailand
  TJK: 'TJ', // Tajikistan
  TKL: 'TK', // Tokelau
  TKM: 'TM', // Turkmenistan
  TLS: 'TL', // Timor-Leste
  TON: 'TO', // Tonga
  TTO: 'TT', // Trinidad and Tobago
  TUN: 'TN', // Tunisia
  TUR: 'TR', // Türkiye
  TUV: 'TV', // Tuvalu
  TWN: 'TW', // Taiwan, Province of China
  TZA: 'TZ', // Tanzania, United Republic of
  UGA: 'UG', // Uganda
  UKR: 'UA', // Ukraine
  UMI: 'UM', // United States Minor Outlying Islands
  URY: 'UY', // Uruguay
  USA: 'US', // United States of America
  UZB: 'UZ', // Uzbekistan
  VAT: 'VA', // Holy See
  VCT: 'VC', // Saint Vincent and the Grenadines
  VEN: 'VE', // Venezuela, Bolivarian Republic of
  VGB: 'VG', // Virgin Islands (British)
  VIR: 'VI', // Virgin Islands (U.S.)
  VNM: 'VN', // Viet Nam
  VUT: 'VU', // Vanuatu
  WLF: 'WF', // Wallis and Futuna
  WSM: 'WS', // Samoa
  YEM: 'YE', // Yemen
  ZAF: 'ZA', // South Africa
  ZMB: 'ZM', // Zambia
  ZWE: 'ZW', // Zimbabwe
});

/**
 * Non-ISO codes that ICPC feeds are known to carry, mapped to alpha-2.
 * These are IOC / historical-legacy codes (a CDS or a hand-maintained
 * DOMjudge organization list may use them). Consulted ONLY after
 * {@link ISO3166_ALPHA3_TO_ALPHA2} misses, so a code that is a valid ISO
 * alpha-3 always keeps its ISO meaning — notably "BRN", which is Brunei in
 * ISO but Bahrain in IOC: ISO wins, and Bahrain must be sent as "BHR".
 *
 * Every key here is verified (by test) to NOT be an ISO alpha-3 code.
 */
export const NON_ISO_ALPHA3_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  // IOC codes, Asia-Pacific (the ones an APAC regional actually sees)
  TPE: 'TW', // Chinese Taipei
  INA: 'ID', // Indonesia
  MAS: 'MY', // Malaysia
  PHI: 'PH', // Philippines
  SIN: 'SG', // Singapore
  VIE: 'VN', // Vietnam
  MYA: 'MM', // Myanmar
  CAM: 'KH', // Cambodia
  NEP: 'NP', // Nepal
  SRI: 'LK', // Sri Lanka
  BAN: 'BD', // Bangladesh
  BRU: 'BN', // Brunei Darussalam
  MGL: 'MN', // Mongolia
  KSA: 'SA', // Saudi Arabia
  UAE: 'AE', // United Arab Emirates
  KUW: 'KW', // Kuwait
  IRI: 'IR', // Iran
  // IOC codes, elsewhere (common in international ICPC data)
  GER: 'DE', // Germany
  SUI: 'CH', // Switzerland
  NED: 'NL', // Netherlands
  DEN: 'DK', // Denmark
  POR: 'PT', // Portugal
  GRE: 'GR', // Greece
  CRO: 'HR', // Croatia
  SLO: 'SI', // Slovenia
  LAT: 'LV', // Latvia
  BUL: 'BG', // Bulgaria
  RSA: 'ZA', // South Africa
  CHI: 'CL', // Chile
  URU: 'UY', // Uruguay
  PAR: 'PY', // Paraguay
  PUR: 'PR', // Puerto Rico
  ALG: 'DZ', // Algeria
  NGR: 'NG', // Nigeria
  ZIM: 'ZW', // Zimbabwe
});

/**
 * Normalizes a feed country code to ISO 3166-1 alpha-2 (uppercase).
 *
 * Returns `undefined` for empty input and for codes we cannot resolve — the
 * caller must treat that as "no flag" rather than guessing. There is no
 * prefix/slice fallback: a wrong flag beside a team name is worse than none.
 */
export function normalizeCountryCode(code: string | null | undefined): string | undefined {
  if (code == null) return undefined;
  const upper = code.trim().toUpperCase();
  if (upper === '') return undefined;
  if (/^[A-Z]{2}$/.test(upper)) return upper; // already alpha-2
  if (!/^[A-Z]{3}$/.test(upper)) return undefined;
  return ISO3166_ALPHA3_TO_ALPHA2[upper] ?? NON_ISO_ALPHA3_ALIASES[upper];
}

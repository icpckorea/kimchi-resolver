# School logo sources

Logos in `public/orgs/logos/` were collected from Wikipedia / Wikimedia Commons
(English and Korean Wikipedia page images, resolved through the Wikipedia and
Commons APIs). Collected 2026-07-30, QA pass on the same day. Nine more
schools were added on 2026-10-17 after the live DOMjudge feed named them, with
the same QA pass.

**Status: 59 of 60 schools in `public/orgs/orgs.json` have a logo (31 SVG, 19 PNG, 9 JPEG).**
`orgs.json` has 61 keys. The extra key is an alias: `Daegu Gyeongbuk Institute of
Science & Technology` (the DOMjudge name) uses the same logo file as
`Daegu Gyungbook Institute of Science and Technology`. Keys must match the
DOMjudge names exactly, including typos (`Hanbat National Unversity`,
`HanShin University`).

License note: all images come from Wikipedia / Wikimedia Commons, except
`jeju-national-university.png`, which comes from the university's own site;
trademarks belong to the respective universities. Used for identification only.

## QA rules applied

- Every file was checked for correct magic bytes and a non-trivial byte size.
- Every file was rendered and inspected by eye. All 58 are a school seal,
  emblem, or official wordmark. No campus photo and no unrelated image remains.
- Raster files larger than ~200 KB were downscaled to 256 px on the long edge
  with `sips -Z 256`.
- All JPEG files had their `APPn` metadata segments (EXIF, ICC profile, Photoshop
  resource blocks) stripped (the 2026-10-17 files with `jpegtran -copy none`).
  `kookmin-university.jpg` alone carried a ~550 KB ICC profile.
- SVG files are kept as-is. `yonsei-university.svg` embeds three small PNG layers;
  it renders correctly, so it is kept.

## Not available (1 school)

| School | Reason |
| --- | --- |
| Korea Aerospace University | No seal, emblem, or wordmark exists on Commons, English Wikipedia, or Korean Wikipedia. `Category:Korea Aerospace University` holds only campus and facility photos. The Korean infobox `로고` field is empty and Wikidata (Q6431586) has no P154 / P158 / P18 claim. |

It is left without a `logo` field in `orgs.json`; the UI falls back to its
no-logo rendering. Re-check if Commons ever gains a free seal for it.

## Notes on individual files

- **Chung-Ang University** — the red outlined square near the `u` is a genuine
  part of the CAU signature, not an annotation. It is present in the Commons SVG
  version of the logo too.
- **Dong-Eui University** — Commons has no emblem for this school, only campus
  photos. The file is the plain black Korean logotype (`동의대학교`). It is the
  official wordmark, but it has no colour and may read poorly on a dark
  background. Replace it if a colour emblem ever becomes available.
- **Kangwon National University**, **Chungnam National University**,
  **Ajou University**, **Pukyong National University**, **Institute of Science
  Tokyo**, **The University of Tokyo** — wide-aspect official wordmark lockups
  rather than round seals. This is what the schools use, so it is correct.
- **Soonchunhyang University** — the file is the `SCH` wordmark (three colour
  blocks with the letters), the logo shown on English Wikipedia. It has no seal.
- **Mokpo National University**, **Hanbat National Unversity** — small wide
  wordmark lockups (188x45 PNG, 170x38 SVG), which is what the schools use.
- **Chungbuk National University** — the shield emblem (`NOVA APERIO`, 1951).
  Commons also holds the newer `cbnu` wordmark (`CBNUlogo.png`); it is not used.
- **Sunchon National University** — English Wikipedia names this school
  `Suncheon National University` (Jeonnam). The Commons file `Scuniv_sig.png`
  shows the wordmark `SUNCHON NATIONAL UNIVERSITY`, which matches the DOMjudge
  spelling.
- **Sangmyung University** — sourced through the Wikidata P158 (seal image)
  claim on Q482819, which the plain Commons text search did not surface.

## Per-school table

| School | Country | File | Bytes | Source |
| --- | --- | --- | ---: | --- |
| Ajou University | KR | ajou-university.png | 8832 | https://en.wikipedia.org/wiki/File:Logo_of_Ajou_University.png |
| Chonnam National University | KR | chonnam-national-university.svg | 19627 | https://en.wikipedia.org/wiki/File:Chonnam_National_University_logo.svg |
| Chosun University | KR | chosun-university.png | 71452 | https://en.wikipedia.org/wiki/File:Logo_for_Chosun_University.png |
| Chung-Ang University | KR | chung-ang-university.png | 41178 | https://commons.wikimedia.org/wiki/File:CAU_emblem.png |
| Chungbuk National University | KR | chungbuk-national-university.png | 52003 | https://en.wikipedia.org/wiki/File:Logo_for_Chungbuk_University.png |
| Chungnam National University | KR | chungnam-national-university.svg | 63467 | https://en.wikipedia.org/wiki/File:Chungnam_National_University_logo.svg |
| Daegu Gyungbook Institute of Science and Technology | KR | daegu-gyungbook-institute-of-science-and-technology.png | 104599 | https://en.wikipedia.org/wiki/File:DGIST_Emblem_2.png |
| Daegu Gyeongbuk Institute of Science & Technology | KR | daegu-gyungbook-institute-of-science-and-technology.png | 104599 | alias key (DOMjudge name), same file as the row above |
| Dankook University | KR | dankook-university.svg | 36899 | https://en.wikipedia.org/wiki/File:Dankook_University_emblem.svg |
| Dong-Eui University | KR | dong-eui-university.jpg | 7464 | https://ko.wikipedia.org/wiki/파일:Dong-Eui_University_logotype.jpg (logotype / wordmark) |
| Dongguk University | KR | dongguk-university.svg | 11491 | https://en.wikipedia.org/wiki/File:Dongguk_University_logo.svg |
| Ewha Womans University | KR | ewha-womans-university.svg | 18983 | https://en.wikipedia.org/wiki/File:Ewha_Womans_University_logo.svg |
| Gachon University | KR | gachon-university.jpg | 32730 | https://commons.wikimedia.org/wiki/File:Gachonemblem.jpg |
| Hanbat National Unversity | KR | hanbat-national-university.svg | 3450 | https://en.wikipedia.org/wiki/File:Hanbat_National_University_logo.svg (key spelled as in DOMjudge) |
| Handong Global University | KR | handong-global-university.png | 86185 | https://en.wikipedia.org/wiki/File:HGUseal.png |
| Hankuk University of Foreign Studies | KR | hankuk-university-of-foreign-studies.png | 103222 | https://en.wikipedia.org/wiki/File:Hankuk_University_of_Foreign_Studies_emblem.png |
| HanShin University | KR | hanshin-university.png | 75587 | https://commons.wikimedia.org/wiki/File:Hanshin_University_Symbol_Logo.png (downscaled from 640 px to 256 px) |
| Hanyang University | KR | hanyang-university.svg | 156386 | https://en.wikipedia.org/wiki/File:Hanyang_University_new_UI.svg |
| Hongik University | KR | hongik-university.svg | 23079 | https://commons.wikimedia.org/wiki/File:Hongik_emblem.svg |
| Incheon National University | KR | incheon-national-university.svg | 44012 | https://en.wikipedia.org/wiki/File:Incheon_National_University.svg |
| Inha University | KR | inha-university.svg | 12856 | https://en.wikipedia.org/wiki/File:Inha_University.svg |
| Institute of Science Tokyo | JP | institute-of-science-tokyo.svg | 7335 | https://commons.wikimedia.org/wiki/File:Institute_of_Science_Tokyo_logo,_basic.svg |
| Jeonbuk National University | KR | jeonbuk-national-university.png | 115938 | https://commons.wikimedia.org/wiki/File:Emblem_of_Jeonbuk_National_University.png |
| KAIST | KR | kaist.svg | 54232 | https://commons.wikimedia.org/wiki/File:KAIST_logo.svg |
| Kangwon National University | KR | kangwon-national-university.svg | 5282 | https://ko.wikipedia.org/wiki/파일:Logo_of_kangwon_national_university.svg |
| Keimyung University | KR | keimyung-university.jpg | 67210 | https://en.wikipedia.org/wiki/File:KMU_emblem.jpg (EXIF stripped) |
| Kongju National University | KR | kongju-national-university.png | 23436 | https://commons.wikimedia.org/wiki/File:KNU_Logo_2013.png |
| Konkuk University | KR | konkuk-university.svg | 152743 | https://en.wikipedia.org/wiki/File:Konkuk_University_logo.svg |
| Kookmin University | KR | kookmin-university.jpg | 18079 | https://en.wikipedia.org/wiki/File:The_emblem_of_Kookmin_University.jpg (downscaled to 256 px, ICC profile stripped) |
| Korea National University of Education | KR | korea-national-university-of-education.png | 67094 | https://en.wikipedia.org/wiki/File:Knue_seal.png |
| Korea University | KR | korea-university.svg | 31571 | https://en.wikipedia.org/wiki/File:Korea_University_Global_Symbol.svg |
| Kyonggi University | KR | kyonggi-university.svg | 2058 | https://commons.wikimedia.org/wiki/File:Logo_of_Kyonggi_University.svg |
| Kyoto University | JP | kyoto-university.svg | 60452 | https://commons.wikimedia.org/wiki/File:Kyoto_University_emblem.svg |
| Kyung Hee University | KR | kyung-hee-university.png | 167251 | https://en.wikipedia.org/wiki/File:Kyung_Hee_University_emblem.png |
| Kyungpook National University | KR | kyungpook-national-university.jpg | 124274 | https://commons.wikimedia.org/wiki/File:Knuemblem00.jpg |
| Kyungsung University | KR | kyungsung-university.jpg | 16907 | https://commons.wikimedia.org/wiki/File:Logo_of_Kyungsung_University.jpg (downscaled from 8500x8500 to 256 px) |
| Mokpo National University | KR | mokpo-national-university.png | 7091 | https://commons.wikimedia.org/wiki/File:Mokpo_National_University_logo.png |
| MyongJi University | KR | myongji-university.svg | 8471 | https://en.wikipedia.org/wiki/File:Myongji_University_logo.svg |
| National Cheng-Chi University | TW | national-cheng-chi-university.svg | 16707 | https://en.wikipedia.org/wiki/File:National_Chengchi_University_Seal.svg |
| National Taiwan Normal University | TW | national-taiwan-normal-university.svg | 18354 | https://en.wikipedia.org/wiki/File:National_Taiwan_Normal_University_logo.svg |
| National Taiwan University | TW | national-taiwan-university.svg | 172928 | https://en.wikipedia.org/wiki/File:National_Taiwan_University_seal.svg |
| Pohang University of Science and Technology | KR | pohang-university-of-science-and-technology.svg | 88047 | https://en.wikipedia.org/wiki/File:POSTECH_emblem.svg |
| Pukyong National University | KR | pukyong-national-university.png | 6789 | https://ko.wikipedia.org/wiki/파일:PKNU_Logo.png |
| Pusan National University | KR | pusan-national-university.svg | 14348 | https://en.wikipedia.org/wiki/File:Pusan_National_University_logo.svg |
| Sangmyung University | KR | sangmyung-university.jpg | 19145 | https://commons.wikimedia.org/wiki/File:Sangmyung_University.jpg ("Official Authority Mark of Sangmyung University", public domain; downscaled to 256 px) |
| Sejong University | KR | sejong-university.svg | 48146 | https://en.wikipedia.org/wiki/File:Sejong_University_logo.svg |
| Seoul National University | KR | seoul-national-university.svg | 19394 | https://en.wikipedia.org/wiki/File:Seoul_national_university_emblem.svg |
| Sogang University | KR | sogang-university.png | 31373 | https://en.wikipedia.org/wiki/File:Sogang_University_emblem.png |
| Sookmyung Women's University | KR | sookmyung-womens-university.svg | 23320 | https://en.wikipedia.org/wiki/File:Sookmyung_Women's_University_logo.svg |
| Soonchunhyang University | KR | soonchunhyang-university.jpg | 63830 | https://commons.wikimedia.org/wiki/File:Soonchunhyang_University_logo.jpg (EXIF stripped; SCH wordmark) |
| Soongsil University | KR | soongsil-university.png | 14245 | https://commons.wikimedia.org/wiki/File:Logo_of_soongsil_university.png |
| Sunchon National University | KR | sunchon-national-university.png | 21366 | https://commons.wikimedia.org/wiki/File:Scuniv_sig.png |
| SungKyunKwan University | KR | sungkyunkwan-university.svg | 11820 | https://en.wikipedia.org/wiki/File:Sungkyunkwan_University_seal.svg |
| The Catholic University of Korea | KR | the-catholic-university-of-korea.svg | 7161 | https://commons.wikimedia.org/wiki/File:Catholic_University_of_Korea_logo.svg |
| The University of Suwon | KR | the-university-of-suwon.png | 14074 | https://commons.wikimedia.org/wiki/File:%EC%88%98%EC%9B%90%EB%8C%80%ED%95%99%EA%B5%90%EC%98%81%EB%AC%B8%EB%A1%9C%EA%B3%A0.png (English-language seal, `수원대학교영문로고.png`) |
| The University of Tokyo | JP | the-university-of-tokyo.svg | 8230 | https://commons.wikimedia.org/wiki/File:University_of_Tokyo_logo_(2024).svg |
| Ulsan National Institute of Science and Technology | KR | ulsan-national-institute-of-science-and-technology.jpg | 10924 | https://en.wikipedia.org/wiki/File:Latest_UNIST_logo.jpg |
| University of Seoul | KR | university-of-seoul.svg | 7331 | https://commons.wikimedia.org/wiki/File:University_of_Seoul.svg |
| Yonsei University | KR | yonsei-university.svg | 182256 | https://en.wikipedia.org/wiki/File:YonseiUniversityEmblem.svg |
| Korea Aerospace University | KR | — | — | none available, see above |
| Jeju National University | KR | jeju-national-university.png | 27903 | https://cms.jejunu.ac.kr/pub/site/jejunu/images/sub/in_emblem.png (official university site; added 2026-10-17, downscaled to 256 px) |

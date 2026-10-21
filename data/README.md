# Bundled unit registry starter data

`uoe-timetable-extracted-units.json` contains provisional code/title pairs extracted from the source PDF in `sources/`.

Source: University of Eldoret, *Master Supplementary/Special Exam Timetable, 2025/2026 Academic Year*, revised final copy dated 20 July 2026 at 11:00 AM.

Important limitations:
- This is an examination timetable, not a master catalogue of every unit offered by the university.
- Some entries use abbreviated titles; table layout, multi-line codes and OCR/text extraction can introduce mistakes.
- Entries are source-labelled `official_timetable` and confidence 0.65 so they are not mistaken for verified current catalogue entries.
- Import the data as a starting point, then add official course catalogues and corrections as separate provenance sources. Do not silently promote these rows to 100% confidence.

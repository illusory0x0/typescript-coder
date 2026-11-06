select file src/reader.ts
match `type Datum =`
replace with
TC_EDIT_BEGIN
export type Datum =
TC_EDIT_END

select file src/reader.ts
match `const MAX_DEPTH = 100;`
replace with
TC_EDIT_BEGIN
const MAX_DEPTH = 1000;
TC_EDIT_END

-- Optional reproducer link on behaviour records.
--
-- Tier I claims a "reproducible eval" — to be credible, the record needs to
-- point at runnable code that re-derives the (model, input, output) tuple
-- from the published model weights. Until now there was no field for it;
-- callers had to bury the URL inside summary text. This adds a first-class
-- column so the cache, the UI, and any cite-this-record consumer can read it
-- directly.
--
-- The column is text rather than a constrained type because reproducers
-- legitimately live in many forms: HuggingFace Space, GitHub repo, gist,
-- Zenodo DOI, IPFS hash. Validation at this layer would over-constrain.

ALTER TABLE public.behaviour
  ADD COLUMN IF NOT EXISTS reproducer_url text;

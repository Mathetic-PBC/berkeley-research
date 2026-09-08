-- Preserve each in-progress reader's current screen as the two positions swap.
-- Applied once by the migration runner; answers and conversations are untouched.
update public.engelbart_onboardings
set step = case step when 6 then 7 when 7 then 6 end, updated_at = now()
where status = 'open' and step in (6, 7);

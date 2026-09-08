-- Mock-ups became a step of its own, sixth in the rail, between Install and
-- Brainstorm. Every step from there on counts one higher, so the rows that
-- hold a step move with it. The check has to make room before the rows do.

alter table public.engelbart_onboardings
  drop constraint if exists engelbart_onboardings_step_check;
alter table public.engelbart_onboardings
  add constraint engelbart_onboardings_step_check check (step between 0 and 13);

-- Open rows so a member in the middle of a setup lands on the screen they
-- left, and finished rows so a step number means the same thing everywhere.
update public.engelbart_onboardings set step = step + 1 where step >= 6;

-- A question was asked from a step; the record of where should still name it.
update public.engelbart_onboarding_asks set step = step + 1 where step >= 6;

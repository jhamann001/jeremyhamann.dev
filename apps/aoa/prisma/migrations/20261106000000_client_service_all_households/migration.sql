-- Client service works every household, not a book of its own: it reads the firm's households and clients the way
-- operations does, while advisors keep their own book. Every client record scoped through these two tables (accounts,
-- AUM, tasks, email, activity, help-desk tickets, held-away summaries, meeting prep) follows. The firm's own household
-- is not a row here (the app adds it for operations and admin only), so client service still does not see it.
-- A session without an email reads nothing, as before.

CREATE POLICY household_client_service_all ON mirror.household FOR SELECT TO app_rw USING (
  current_setting('app.user_role', true) = 'CLIENT_SERVICE'
  AND NULLIF(current_setting('app.user_email', true), '') IS NOT NULL
);
CREATE POLICY client_client_service_all ON mirror.client FOR SELECT TO app_rw USING (
  current_setting('app.user_role', true) = 'CLIENT_SERVICE'
  AND NULLIF(current_setting('app.user_email', true), '') IS NOT NULL
);

ALTER POLICY household_own_book ON mirror.household USING (
  current_setting('app.user_role', true) = 'ADVISOR'
  AND lead_advisor_email = current_setting('app.user_email', true)
);
ALTER POLICY client_own_book ON mirror.client USING (
  current_setting('app.user_role', true) = 'ADVISOR'
  AND lead_advisor_email = current_setting('app.user_email', true)
);

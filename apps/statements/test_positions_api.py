"""Positions API regressions. SQL tests use only an explicit TEST_DATABASE_URL.

Each SQL test creates the real app schema inside a transaction and rolls it
back, with synthetic accounts only. CI supplies a disposable Postgres service.
"""

import os
import unittest
from contextlib import closing, contextmanager
from datetime import datetime
from types import SimpleNamespace
from unittest import mock
from uuid import uuid4

import psycopg2
from psycopg2 import sql
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

import automation_pipeline as ap
import db
import server


@unittest.skipUnless(os.getenv("TEST_DATABASE_URL"), "Requires disposable test Postgres")
class PositionsLookupTests(unittest.TestCase):
    def setUp(self):
        self.conn = psycopg2.connect(os.environ["TEST_DATABASE_URL"])
        self.addCleanup(self.conn.close)
        self.addCleanup(self.conn.rollback)
        with self.conn.cursor() as cur:
            schema = "positions_test_" + uuid4().hex
            cur.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
            cur.execute(sql.SQL("SET LOCAL search_path TO {}").format(sql.Identifier(schema)))
            cur.execute(db._TABLES_SQL)
            cur.execute(db._MIGRATION_SQL)
            cur.execute(db._VIEWS_SQL)

    def account(self, number="123-004567-890", *, deleted=False, superseded=False, folder=None, processed="2026-09-01", holder="Synthetic Owner", custodian="Synthetic Custodian", investor=None, registration=None):
        household_id, account_id = str(uuid4()), str(uuid4())
        with self.conn.cursor() as cur:
            cur.execute(
                "INSERT INTO households (id, client_name, superseded_by, source_folder_id, processed_at) VALUES (%s, %s, %s, %s, %s)",
                (household_id, "Synthetic Client", str(uuid4()) if superseded else None, folder, processed),
            )
            cur.execute(
                """INSERT INTO accounts
                   (id, household_id, account_number, statement_date,
                    statement_age_days, is_stale, deleted_at, account_holder, custodian, investor_number, account_registration)
                   VALUES (%s, %s, %s, '2026-06-30', 23, FALSE, %s, %s, %s, %s, %s)""",
                (account_id, household_id, number,
                 datetime.now(ap.ET) if deleted else None, holder, custodian, investor, registration),
            )
        return account_id

    def position(self, account_id, *, deleted=False):
        with self.conn.cursor() as cur:
            cur.execute(
                """INSERT INTO positions
                   (id, account_id, symbol, quantity, transfer_eligible,
                    transfer_notes, override_status, override_notes, transferring, deleted_at)
                   VALUES (%s, %s, 'TEST', 12, 'ACAT', 'Engine note',
                           'LIQUIDATE', 'Reviewed note', 'NO', %s)""",
                (str(uuid4()), account_id, datetime.now(ap.ET) if deleted else None),
            )

    def test_formatted_and_unformatted_lookups_return_the_same_account(self):
        account_id = self.account()
        self.position(account_id)
        for query in ("123004567890", "123-004567-890", " 123 004567 890\t"):
            with self.subTest(query=query):
                result = db.get_positions_by_account_number(self.conn, query)
                self.assertEqual(result["id"], account_id)
                self.assertEqual(result["account_number"], "123-004567-890")
                self.assertEqual(len(result["positions"]), 1)

    def test_ignores_stored_whitespace_and_case_but_preserves_letters_and_zeros(self):
        account_id = self.account(" ab0 - 001234 ")
        self.assertEqual(db.get_positions_by_account_number(self.conn, "AB0001234")["id"], account_id)
        for query in ("0001234", "AB01234", "XB0001234", "001234", "****1234", " - "):
            with self.subTest(query=query):
                self.assertIsNone(db.get_positions_by_account_number(self.conn, query))

    def test_does_not_match_masked_source_numbers(self):
        self.account("****7890")
        self.assertIsNone(db.get_positions_by_account_number(self.conn, "7890"))

    def test_other_punctuation_remains_significant(self):
        account_id = self.account("AB/001234")
        self.assertEqual(db.get_positions_by_account_number(self.conn, "AB/001234")["id"], account_id)
        self.assertIsNone(db.get_positions_by_account_number(self.conn, "AB001234"))

    def test_deleted_and_superseded_accounts_are_excluded(self):
        self.account(deleted=True)
        self.account(superseded=True)
        self.assertIsNone(db.get_positions_by_account_number(self.conn, "123004567890"))
        account_id = self.account()
        self.assertEqual(db.get_positions_by_account_number(self.conn, "123004567890")["id"], account_id)

    def test_ambiguous_live_matches_fail_even_when_one_has_exact_formatting(self):
        self.account()
        self.account("123004567890")
        for query in ("123004567890", "123-004567-890"):
            with self.subTest(query=query):
                with self.assertRaises(db.AmbiguousAccountNumberError):
                    db.get_positions_by_account_number(self.conn, query)

    def test_effective_overrides_and_transfer_selection_are_preserved(self):
        account_id = self.account()
        self.position(account_id)
        self.position(account_id, deleted=True)
        positions = db.get_positions_by_account_number(self.conn, "123004567890")["positions"]
        self.assertEqual(len(positions), 1)
        self.assertEqual(positions[0]["effective_status"], "LIQUIDATE")
        self.assertEqual(positions[0]["effective_notes"], "Reviewed note")
        self.assertEqual(positions[0]["transferring"], "NO")

    def test_account_reclassification_loads_preferred_source_and_keeps_overrides(self):
        account_id = self.account()
        self.position(account_id)
        with self.conn.cursor() as cur:
            cur.execute(
                """UPDATE positions SET asset_type = 'Preferred Stock',
                          classification_source = 'ticker_db'
                   WHERE account_id = %s""",
                (account_id,),
            )
        _, positions = db.get_account_for_reclassification(self.conn, account_id)
        self.assertEqual(positions[0]["classification_source"], "ticker_db")
        _, updates = ap.reclassify_for_new_account_type("Individual", None, positions)
        self.assertEqual(updates[0]["transfer_eligible"], "ACAT")
        self.assertEqual(positions[0]["override_status"], "LIQUIDATE")
        effective = db.get_positions_by_account_number(self.conn, "123004567890")["positions"][0]
        self.assertEqual(effective["asset_type"], "Preferred Stock")
        self.assertEqual(effective["effective_status"], "LIQUIDATE")
        self.assertEqual(effective["transferring"], "NO")

    def test_freshness_is_recomputed_without_changing_saved_source_data(self):
        account_id = self.account()
        with mock.patch.object(ap, "datetime", wraps=datetime) as clock:
            clock.now.return_value = datetime(2026, 9, 15, 12, tzinfo=ap.ET)
            with mock.patch.dict(os.environ, {"STATEMENT_STALE_DAYS": "60"}):
                result = db.get_positions_by_account_number(self.conn, "123004567890")
            self.assertEqual(result["statement_age_days"], 77)
            self.assertTrue(result["is_stale"])
            with mock.patch.dict(os.environ, {"STATEMENT_STALE_DAYS": "90"}):
                result = db.get_positions_by_account_number(self.conn, "123004567890")
            self.assertFalse(result["is_stale"])
        with self.conn.cursor() as cur:
            cur.execute("SELECT statement_age_days, is_stale FROM accounts WHERE id = %s", (account_id,))
            self.assertEqual(cur.fetchone(), (23, False))

    def test_partial_household_rerun_keeps_previous_distinct_account(self):
        old = self.account(folder="family-a", superseded=True, processed="2026-07-01")
        self.position(old)
        self.account("OTHER-123", folder="family-a", processed="2026-09-01")
        result = db.get_positions_by_account_number(self.conn, "123004567890")
        self.assertEqual(result["id"], old)
        self.assertTrue(result["is_historical"])
        self.assertEqual(len(result["positions"]), 1)
        self.assertEqual(result["statement_date"], "2026-06-30")

    def test_current_match_and_saved_link_survive_custodian_label_and_folder_changes(self):
        old = self.account(folder="old-folder", custodian="Synthetic Custodian LLC", superseded=True, processed="2026-07-01")
        new = self.account(folder="new-folder", custodian="Synthetic Custodian")
        with self.conn.cursor() as cur:
            cur.execute("UPDATE households SET superseded_by = (SELECT household_id FROM accounts WHERE id = %s) WHERE id = (SELECT household_id FROM accounts WHERE id = %s)", (new, old))
        self.assertEqual(db.get_positions_by_account_number(self.conn, "123004567890")["id"], new)
        self.assertEqual(db.get_positions_by_account_id(self.conn, old)["id"], new)
        self.assertEqual([a["id"] for a in db.search_position_accounts(self.conn, "Synthetic")["accounts"]], [new])

    def test_deleted_latest_number_blocks_fallback_even_after_custodian_label_change(self):
        self.account(folder="family-a", custodian="Synthetic Custodian LLC", superseded=True, processed="2026-07-01")
        self.account(folder="family-a", custodian="Synthetic Custodian", deleted=True)
        self.assertIsNone(db.get_positions_by_account_number(self.conn, "123004567890"))

    def test_explicit_selection_disambiguates_two_accounts_with_same_number(self):
        one = self.account(folder="family-a")
        self.account(folder="family-b")
        with self.assertRaises(db.AmbiguousAccountNumberError):
            db.get_positions_by_account_number(self.conn, "123004567890")
        self.assertEqual(db.get_positions_by_account_id(self.conn, one)["id"], one)

    def test_saved_link_follows_latest_full_identity(self):
        old = self.account(folder="family-a", superseded=True, processed="2026-07-01")
        new = self.account(folder="family-a", processed="2026-09-01")
        self.assertEqual(db.get_positions_by_account_id(self.conn, old)["id"], new)
        self.assertEqual(db.get_positions_by_account_number(self.conn, "123004567890")["id"], new)

    def test_deleted_latest_version_does_not_resurrect_previous_positions(self):
        old = self.account(folder="family-a", superseded=True, processed="2026-07-01")
        self.account(folder="family-a", deleted=True, processed="2026-09-01")
        self.assertIsNone(db.get_positions_by_account_number(self.conn, "123004567890"))
        self.assertIsNone(db.get_positions_by_account_id(self.conn, old))
        self.assertEqual(db.search_position_accounts(self.conn, "Synthetic")["accounts"], [])

    def test_shared_number_replaced_by_numberless_registrations_requires_selection(self):
        old = self.account("INVESTOR-42", folder="family-a", superseded=True, processed="2026-07-01")
        ira = self.account(None, folder="family-a", registration="Traditional IRA")
        roth = self.account(None, folder="family-a", registration="Roth IRA")
        self.position(ira)
        self.position(roth)
        with self.assertRaises(db.AmbiguousAccountNumberError):
            db.get_positions_by_account_number(self.conn, "INVESTOR42")
        with self.assertRaises(db.AmbiguousAccountNumberError):
            db.get_positions_by_account_id(self.conn, old)
        self.assertEqual(db.get_positions_by_account_id(self.conn, ira)["id"], ira)
        self.assertEqual(len(db.get_positions_by_account_id(self.conn, roth)["positions"]), 1)
        choices = db.search_position_accounts(self.conn, "Synthetic")["accounts"]
        self.assertEqual({a["id"] for a in choices}, {ira, roth})

    def test_investor_and_registration_persist_and_stably_resolve(self):
        old = self.account(None, folder="family-a", investor="INV-42", registration="Roth IRA", superseded=True, processed="2026-07-01")
        new = self.account(None, folder="family-a", investor="INV42", registration="Roth IRA")
        self.account(None, folder="family-a", investor="INV42", registration="Traditional IRA")
        self.assertEqual(db.get_positions_by_account_id(self.conn, old)["id"], new)
        with self.assertRaises(db.AmbiguousAccountNumberError):
            db.get_positions_by_account_number(self.conn, "INV42")
        conn = mock.Mock(wraps=self.conn)
        conn.commit = mock.Mock()
        household = db.write_household(conn, {"client_name": "Synthetic Saved", "accounts": [{"account_number": None, "investor_number": "INV-SAVE", "account_registration": "Roth IRA", "assets": []}]}, "family-save")
        with self.conn.cursor() as cur:
            cur.execute("SELECT investor_number, account_registration FROM accounts WHERE household_id = %s", (household,))
            self.assertEqual(cur.fetchone(), ("INV-SAVE", "Roth IRA"))

    def test_numberless_legacy_link_requires_reselection_after_replacement(self):
        old = self.account(None, folder="family-a", superseded=True, processed="2026-07-01")
        self.account(None, folder="family-a")
        with self.assertRaises(db.AmbiguousAccountNumberError):
            db.get_positions_by_account_id(self.conn, old)

    def test_dashboard_masks_investor_numbers_while_machine_lookup_preserves_them(self):
        account = self.account(None, folder="family-a", investor="INV123456", registration="Roth IRA")
        machine = db.get_positions_by_account_id(self.conn, account)
        self.assertEqual(machine["investor_number"], "INV123456")
        detail = db.get_household_detail(self.conn, machine["household_id"])
        self.assertNotEqual(detail["accounts"][0]["investor_number"], "INV123456")
        self.assertTrue(detail["accounts"][0]["investor_number"].endswith("3456"))

    def test_search_is_discovery_only_and_sql_wildcards_are_literal(self):
        self.account(folder="family-a")
        self.account(folder="family-b")
        self.assertEqual(len(db.search_position_accounts(self.conn, "Synthetic")["accounts"]), 2)
        self.assertEqual(db.search_position_accounts(self.conn, "Synt%_")["accounts"], [])
        with self.assertRaises(db.AmbiguousAccountNumberError):
            db.get_positions_by_account_number(self.conn, "123004567890")

    def test_http_refresh_returns_positions_and_current_context(self):
        account_id = self.account()
        self.position(account_id)
        with closing(TestClient(server.app)) as client, \
             mock.patch.object(server.pipeline_auth, "verify_positions_api_token", return_value="test-sa"), \
             mock.patch.object(db, "get_connection", return_value=self.conn), \
             mock.patch.object(db, "put_connection"), \
             mock.patch.object(ap, "datetime", wraps=datetime) as clock, \
             mock.patch.dict(os.environ, {"STATEMENT_STALE_DAYS": "60"}):
            clock.now.return_value = datetime(2026, 9, 15, 12, tzinfo=ap.ET)
            response = client.get("/api/v1/positions?account_number=123004567890", headers={"Authorization": "Bearer synthetic-token"})
        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertEqual(result["account_number"], "123-004567-890")
        self.assertEqual(result["statement_date"], "2026-06-30")
        self.assertEqual(result["statement_age_days"], 77)
        self.assertTrue(result["is_stale"])
        self.assertEqual(result["positions"][0]["effective_status"], "LIQUIDATE")
        self.assertEqual(result["positions"][0]["effective_notes"], "Reviewed note")
        self.assertEqual(result["positions"][0]["transferring"], "NO")


class PositionsEndpointTests(unittest.TestCase):
    def setUp(self):
        # No lifespan context: these tests must never start scanners or DB pools.
        self.client = TestClient(server.app)
        self.addCleanup(self.client.close)
        self.request_headers = {"Authorization": "Bearer synthetic-token"}

    def test_authentication_is_required_before_database_access(self):
        with mock.patch.object(db, "get_connection") as connect:
            response = self.client.get("/api/v1/positions?account_number=123004567890")
        self.assertEqual(response.status_code, 401)
        connect.assert_not_called()

    def test_invalid_or_unapproved_callers_cannot_access_database(self):
        for status in (401, 403):
            with self.subTest(status=status):
                with mock.patch.object(db, "get_connection") as connect, \
                     mock.patch.object(server.pipeline_auth, "verify_positions_api_token", side_effect=server.pipeline_auth.AuthError(status, "Rejected test caller")):
                    response = self.client.get("/api/v1/positions?account_number=123004567890", headers=self.request_headers)
                self.assertEqual(response.status_code, status)
                connect.assert_not_called()

    def test_source_search_and_id_lookup_require_auth_and_validate_inputs(self):
        with mock.patch.object(db, "get_connection") as connect:
            self.assertEqual(self.client.get("/api/v1/position-accounts?q=Test").status_code, 401)
            self.assertEqual(self.client.get("/api/v1/positions?account_id=" + str(uuid4())).status_code, 401)
            connect.assert_not_called()
        with mock.patch.object(server.pipeline_auth, "verify_positions_api_token", return_value="test-sa"), mock.patch.object(db, "get_connection") as connect:
            for path in ("/api/v1/position-accounts?q=x", "/api/v1/positions?account_id=invalid", "/api/v1/positions?account_id=" + str(uuid4()) + "&account_number=123"):
                self.assertEqual(self.client.get(path, headers=self.request_headers).status_code, 400)
            connect.assert_not_called()

    def test_missing_unknown_and_ambiguous_account_responses(self):
        with mock.patch.object(server.pipeline_auth, "verify_positions_api_token", return_value="test-sa"):
            with mock.patch.object(db, "get_connection") as connect:
                response = self.client.get("/api/v1/positions", headers=self.request_headers)
            self.assertEqual(response.status_code, 400)
            connect.assert_not_called()
            for outcome, status in ((None, 404), (db.AmbiguousAccountNumberError("Multiple live accounts match this account number"), 409)):
                with self.subTest(status=status):
                    with mock.patch.object(db, "get_connection") as connect, \
                         mock.patch.object(db, "put_connection") as release, \
                         mock.patch.object(db, "get_positions_by_account_number") as lookup:
                        if isinstance(outcome, Exception):
                            lookup.side_effect = outcome
                        else:
                            lookup.return_value = outcome
                        response = self.client.get("/api/v1/positions?account_number=123004567890", headers=self.request_headers)
                    self.assertEqual(response.status_code, status)
                    release.assert_called_once_with(connect.return_value)
                    self.assertNotIn("positions", response.json())


def _dependency_calls(dependant):
    for dep in dependant.dependencies:
        yield dep.call
        yield from _dependency_calls(dep)


class OpsPortalEditAuthTests(unittest.TestCase):
    SA = "ops-portal-run@synthetic-project.iam.gserviceaccount.com"
    AUD = "https://pipeline.example.test"
    EDIT_ROUTES = {
        ("PATCH", "/api/positions/{position_id}/status"),
        ("PATCH", "/api/positions/{position_id}/transferring"),
        ("PATCH", "/api/accounts/{account_id}/type"),
        ("DELETE", "/api/positions/{position_id}"),
        ("PATCH", "/api/positions/{position_id}/restore"),
        ("DELETE", "/api/accounts/{account_id}"),
        ("PATCH", "/api/accounts/{account_id}/restore"),
    }
    OPS_DOCUMENT_ROUTES = {
        ("POST", "/api/households/{household_id}/save-to-drive"),
        ("POST", "/api/scan"),
    }
    PDF_ROUTES = {
        ("GET", "/api/households/{household_id}/pdf"),
        ("GET", "/api/households/export/pdf"),
    }
    DESTINATION_ROUTES = {
        ("POST", "/api/clients/{source_folder_id}/destinations"),
        ("PATCH", "/api/destinations/{target_id}"),
        ("DELETE", "/api/destinations/{target_id}"),
        ("POST", "/api/source-accounts/reassign"),
    }

    def setUp(self):
        self.client = TestClient(server.app)
        self.addCleanup(self.client.close)
        self.headers = {"Authorization": "Bearer synthetic-token"}
        self.position_id, self.account_id = str(uuid4()), str(uuid4())

    def edit_requests(self):
        p, a = self.position_id, self.account_id
        return [
            ("PATCH", f"/api/positions/{p}/status", {"status": "LIQUIDATE", "notes": "Manual override to LIQUIDATE"}),
            ("PATCH", f"/api/positions/{p}/transferring", {"value": "YES"}),
            ("PATCH", f"/api/accounts/{a}/type", {"account_type": "IRA", "account_type_other": None}),
            ("DELETE", f"/api/positions/{p}", None),
            ("PATCH", f"/api/positions/{p}/restore", None),
            ("DELETE", f"/api/accounts/{a}", None),
            ("PATCH", f"/api/accounts/{a}/restore", None),
        ]

    def send(self, method, path, body):
        return self.client.request(method, path, json=body, headers=self.headers)

    @contextmanager
    def audience_env(self, cloud_run_url=None, expected=None):
        env = {k: v for k, v in os.environ.items()
               if k not in ("CLOUD_RUN_URL", "POSITIONS_API_EXPECTED_AUDIENCE")}
        if cloud_run_url is not None:
            env["CLOUD_RUN_URL"] = cloud_run_url
        if expected is not None:
            env["POSITIONS_API_EXPECTED_AUDIENCE"] = expected
        with mock.patch.dict(os.environ, env, clear=True):
            yield

    @contextmanager
    def service_account(self, aud=None, cloud_run_url=AUD, expected=None):
        claims = {"aud": aud or self.AUD, "email": self.SA}
        with self.audience_env(cloud_run_url, expected), \
             mock.patch.object(server.pipeline_auth, "verify_web_user_token",
                               side_effect=server.pipeline_auth.AuthError(401, "Token audience not accepted")), \
             mock.patch.object(server.pipeline_auth, "verify_google_id_token", return_value=claims), \
             mock.patch.object(server.pipeline_auth, "verify_ops_portal_edit_token", return_value=self.SA) as sa:
            yield sa

    @contextmanager
    def writes(self):
        fields = {"account_type": "IRA", "account_type_other": None, "is_rollover": False,
                  "is_inherited": False, "apex_restriction": None}
        with mock.patch.object(db, "get_connection", return_value=object()) as connect, \
             mock.patch.object(db, "put_connection"), \
             mock.patch.object(db, "update_position_override", return_value=True) as status, \
             mock.patch.object(db, "set_position_transferring", return_value=True) as transferring, \
             mock.patch.object(db, "get_account_for_reclassification", return_value=({}, [])), \
             mock.patch.object(server, "reclassify_for_new_account_type", return_value=(fields, [])), \
             mock.patch.object(server, "_get_apex_rules_db", return_value=None), \
             mock.patch.object(db, "apply_account_type_change", return_value=0) as account_type, \
             mock.patch.object(db, "soft_delete_position", return_value=True) as delete_position, \
             mock.patch.object(db, "restore_position", return_value=True), \
             mock.patch.object(db, "soft_delete_account", return_value=True) as delete_account, \
             mock.patch.object(db, "restore_account", return_value=True):
            yield SimpleNamespace(connect=connect, status=status, transferring=transferring,
                                  account_type=account_type, delete_position=delete_position,
                                  delete_account=delete_account)

    def test_service_account_can_call_each_of_the_seven_edit_routes(self):
        with self.service_account(), self.writes():
            for method, path, body in self.edit_requests():
                with self.subTest(route=f"{method} {path}"):
                    self.assertEqual(self.send(method, path, body).status_code, 200)

    def test_service_account_email_is_recorded_as_the_actor(self):
        with self.service_account(), self.writes() as w:
            for method, path, body in self.edit_requests():
                self.send(method, path, body)
        self.assertEqual(w.status.call_args.args[4], self.SA)
        self.assertEqual(w.transferring.call_args.args[3], self.SA)
        self.assertEqual(w.account_type.call_args.args[2], self.SA)
        self.assertEqual(w.delete_position.call_args.args[2], self.SA)
        self.assertEqual(w.delete_account.call_args.args[2], self.SA)

    def test_ops_web_user_is_still_accepted_on_the_edit_routes(self):
        ops = {"email": "ops@example.invalid", "role": "ops"}
        with mock.patch.object(server.pipeline_auth, "verify_web_user_token", return_value=ops), \
             mock.patch.object(server.pipeline_auth, "verify_ops_portal_edit_token") as sa, \
             self.writes() as w:
            codes = [self.send(m, p, b).status_code for m, p, b in self.edit_requests()]
        self.assertEqual(codes, [200] * 7)
        sa.assert_not_called()
        self.assertEqual(w.status.call_args.args[4], "ops@example.invalid")

    def test_advisor_web_user_is_rejected_before_any_write(self):
        advisor = {"email": "advisor@example.invalid", "role": "advisor"}
        with mock.patch.object(server.pipeline_auth, "verify_web_user_token", return_value=advisor), \
             self.writes() as w:
            codes = [self.send(m, p, b).status_code for m, p, b in self.edit_requests()]
        self.assertEqual(codes, [403] * 7)
        w.connect.assert_not_called()

    def test_unknown_token_gets_the_web_user_error_before_any_write(self):
        with self.audience_env(), \
             mock.patch.object(server.pipeline_auth, "verify_web_user_token",
                               side_effect=server.pipeline_auth.AuthError(401, "Token audience not accepted")), \
             mock.patch.object(server.pipeline_auth, "verify_ops_portal_edit_token",
                               side_effect=server.pipeline_auth.AuthError(403, "Service account not authorized")), \
             self.writes() as w:
            responses = [self.send(m, p, b) for m, p, b in self.edit_requests()]
        self.assertEqual([r.status_code for r in responses], [401] * 7)
        self.assertEqual(responses[0].json()["detail"], "Token audience not accepted")
        w.connect.assert_not_called()

    def test_service_account_is_still_rejected_on_other_ops_routes(self):
        other = [
            ("GET", "/api/households"),
            ("GET", f"/api/households/{uuid4()}"),
            ("GET", "/api/me"),
            ("GET", "/api/users"),
            ("DELETE", f"/api/users/{uuid4()}"),
            ("GET", "/api/mcp-tokens"),
            ("DELETE", f"/api/mcp-tokens/{uuid4()}"),
        ]
        with self.service_account(), mock.patch.object(db, "get_connection") as connect:
            codes = [self.client.request(m, p, headers=self.headers).status_code for m, p in other]
        self.assertEqual(codes, [401] * 7)
        connect.assert_not_called()

    def test_only_the_seven_edit_routes_accept_the_service_account(self):
        routes = {
            (method, route.path)
            for route in server.app.routes if isinstance(route, APIRoute)
            for method in route.methods
            if server.require_ops_or_ops_portal_service_account in set(_dependency_calls(route.dependant))
        }
        self.assertEqual(routes, self.EDIT_ROUTES | self.DESTINATION_ROUTES | self.OPS_DOCUMENT_ROUTES)

    def test_only_the_two_pdf_routes_accept_the_service_account_as_any_user(self):
        routes = {
            (method, route.path)
            for route in server.app.routes if isinstance(route, APIRoute)
            for method in route.methods
            if server.get_current_user_or_ops_portal_service_account in set(_dependency_calls(route.dependant))
        }
        self.assertEqual(routes, self.PDF_ROUTES)

    def test_service_account_with_wrong_audience_is_rejected_before_any_write(self):
        with self.service_account(aud="https://other-service.example.test") as sa, self.writes() as w:
            responses = [self.send(m, p, b) for m, p, b in self.edit_requests()]
        self.assertEqual([r.status_code for r in responses], [401] * 7)
        self.assertEqual(responses[0].json()["detail"], "Token audience not accepted")
        sa.assert_not_called()
        w.connect.assert_not_called()

    def test_service_account_is_rejected_when_no_audience_is_configured(self):
        with self.service_account(cloud_run_url=None) as sa, self.writes() as w:
            codes = [self.send(m, p, b).status_code for m, p, b in self.edit_requests()]
        self.assertEqual(codes, [401] * 7)
        sa.assert_not_called()
        w.connect.assert_not_called()

    def test_expected_audience_setting_takes_precedence_over_cloud_run_url(self):
        configured = "https://pipeline-alias.example.test/"
        with self.service_account(aud=self.AUD, expected=configured), self.writes():
            self.assertEqual(self.send(*self.edit_requests()[0]).status_code, 401)
        with self.service_account(aud=configured.rstrip("/"), expected=configured), self.writes():
            self.assertEqual(self.send(*self.edit_requests()[0]).status_code, 200)


class OpsPortalDestinationRouteTests(unittest.TestCase):
    SA = OpsPortalEditAuthTests.SA
    AUD = OpsPortalEditAuthTests.AUD
    audience_env = OpsPortalEditAuthTests.audience_env
    service_account = OpsPortalEditAuthTests.service_account
    READ = "/api/v1/clients/{source_folder_id}/destinations"

    def setUp(self):
        self.client = TestClient(server.app)
        self.addCleanup(self.client.close)
        self.headers = {"Authorization": "Bearer synthetic-token"}
        self.folder, self.target_id, self.link_id = "synthetic-folder", str(uuid4()), str(uuid4())

    def write_requests(self):
        f, t, l = self.folder, self.target_id, self.link_id
        return [
            ("POST", f"/api/clients/{f}/destinations", {"owner": "Synthetic Owner", "target_account_type": "Individual"}),
            ("PATCH", f"/api/destinations/{t}", {"needs_to_be_opened": False}),
            ("DELETE", f"/api/destinations/{t}", None),
            ("POST", "/api/source-accounts/reassign", {"link_id": l, "target_account_id": t}),
        ]

    def send(self, method, path, body):
        return self.client.request(method, path, json=body, headers=self.headers)

    def read(self, headers=None):
        return self.client.get(f"/api/v1/clients/{self.folder}/destinations",
                               headers=self.headers if headers is None else headers)

    @contextmanager
    def writes(self):
        with mock.patch.object(db, "get_connection", return_value=object()) as connect, \
             mock.patch.object(db, "put_connection"), \
             mock.patch.object(db, "create_target_account", return_value=self.target_id) as create, \
             mock.patch.object(db, "set_target_account", return_value=True) as patch_target, \
             mock.patch.object(db, "delete_target_account", return_value=True), \
             mock.patch.object(db, "reassign_link", return_value=True) as reassign, \
             mock.patch.object(db, "link_folder", return_value=self.folder):
            yield SimpleNamespace(connect=connect, create=create, patch=patch_target, reassign=reassign)

    def destination_rows(self):
        return [{
            "id": self.target_id, "owner": "Synthetic Owner", "target_account_type": "Individual",
            "existing_apex_number": None, "needs_to_be_opened": True,
            "sources": [{"link_id": self.link_id, "custodian": "Synthetic Custodian",
                         "account_number": "000000001234"}],
            "suggestion": {"existing_count": 0, "matched_titles": [], "matched_numbers": [],
                           "suggested_apex_number": None},
        }]

    def test_service_account_can_call_each_of_the_four_destination_routes(self):
        with self.service_account(), self.writes():
            for method, path, body in self.write_requests():
                with self.subTest(route=f"{method} {path}"):
                    self.assertEqual(self.send(method, path, body).status_code, 200)

    def test_service_account_email_is_recorded_as_the_destination_actor(self):
        new = {"link_id": self.link_id, "source_folder_id": self.folder,
               "new_owner": "Synthetic Owner", "new_target_account_type": "Individual"}
        with self.service_account(), self.writes() as w:
            for method, path, body in self.write_requests():
                self.send(method, path, body)
            self.assertEqual(w.create.call_args.kwargs["user"], self.SA)
            self.assertEqual(w.patch.call_args.kwargs["user"], self.SA)
            self.assertEqual(w.reassign.call_args.kwargs["user"], self.SA)
            self.assertEqual(self.send("POST", "/api/source-accounts/reassign", new).status_code, 200)
            self.assertEqual(w.create.call_args.kwargs["user"], self.SA)

    def test_ops_web_user_is_still_accepted_on_the_destination_routes(self):
        ops = {"email": "ops@example.invalid", "role": "ops"}
        with mock.patch.object(server.pipeline_auth, "verify_web_user_token", return_value=ops), \
             mock.patch.object(server.pipeline_auth, "verify_households_api_token") as sa, \
             self.writes() as w:
            codes = [self.send(m, p, b).status_code for m, p, b in self.write_requests()]
        self.assertEqual(codes, [200] * 4)
        sa.assert_not_called()
        self.assertEqual(w.create.call_args.kwargs["user"], "ops@example.invalid")

    def test_advisor_web_user_is_rejected_on_the_destination_routes_before_any_write(self):
        advisor = {"email": "advisor@example.invalid", "role": "advisor"}
        with mock.patch.object(server.pipeline_auth, "verify_web_user_token", return_value=advisor), \
             self.writes() as w:
            codes = [self.send(m, p, b).status_code for m, p, b in self.write_requests()]
        self.assertEqual(codes, [403] * 4)
        w.connect.assert_not_called()

    def test_service_account_with_wrong_audience_is_rejected_on_the_destination_routes(self):
        with self.service_account(aud="https://other.example.test"), self.writes() as w:
            codes = [self.send(m, p, b).status_code for m, p, b in self.write_requests()]
        self.assertEqual(codes, [401] * 4)
        w.connect.assert_not_called()

    def test_destinations_read_returns_masked_source_numbers_to_the_service_account(self):
        with mock.patch.object(server.pipeline_auth, "verify_households_api_token", return_value=self.SA) as sa, \
             mock.patch.object(db, "get_connection", return_value=object()) as connect, \
             mock.patch.object(db, "put_connection") as release, \
             mock.patch.object(db, "get_destinations_for_client", return_value=self.destination_rows()) as read:
            response = self.read()
        self.assertEqual(response.status_code, 200)
        source = response.json()["destinations"][0]["sources"][0]
        self.assertEqual(source["account_number"], "\u2022" * 8 + "1234")
        self.assertNotIn("000000001234", response.text)
        sa.assert_called_once_with("synthetic-token")
        read.assert_called_once_with(connect.return_value, self.folder)
        release.assert_called_once_with(connect.return_value)

    def test_destinations_read_requires_an_allowlisted_service_account_before_database_access(self):
        with mock.patch.object(server.pipeline_auth, "verify_households_api_token",
                               side_effect=server.pipeline_auth.AuthError(403, "Service account not authorized")), \
             mock.patch.object(db, "get_connection") as connect:
            missing = self.read(headers={})
            refused = self.read()
        self.assertEqual((missing.status_code, refused.status_code), (401, 403))
        connect.assert_not_called()

    def test_destinations_read_failure_returns_a_static_error_and_releases_the_connection(self):
        with mock.patch.object(server.pipeline_auth, "verify_households_api_token", return_value=self.SA), \
             mock.patch.object(db, "get_connection", return_value=object()) as connect, \
             mock.patch.object(db, "put_connection") as release, \
             mock.patch.object(db, "get_destinations_for_client", side_effect=RuntimeError("synthetic internal detail")):
            response = self.read()
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["detail"], "Failed to read destinations")
        self.assertNotIn("synthetic internal detail", response.text)
        release.assert_called_once_with(connect.return_value)

    def test_destinations_read_uses_only_the_households_service_account_check(self):
        route = next(r for r in server.app.routes if isinstance(r, APIRoute) and r.path == self.READ)
        calls = set(_dependency_calls(route.dependant))
        self.assertEqual(route.methods, {"GET"})
        self.assertIn(server._verify_households_api_caller, calls)
        for other in (server.require_ops, server.get_current_user, server.require_ops_or_ops_portal_service_account):
            self.assertNotIn(other, calls)


class OpsPortalDocumentsAuthTests(unittest.TestCase):
    SA = OpsPortalEditAuthTests.SA
    AUD = OpsPortalEditAuthTests.AUD
    HID = "00000000-0000-4000-8000-000000000001"
    SCAN_ENV = {
        "GOOGLE_CREDENTIALS_PATH": "/synthetic/credentials.json", "OUTPUT_FOLDER_ID": "synthetic-output",
        "INPUT_FOLDER_ID": "synthetic-input", "PROCESSED_FOLDER_ID": "synthetic-processed",
        "GCP_PROJECT_ID": "synthetic-project", "NOTION_TOKEN_KEY": "synthetic", "NOTION_DATABASE_ID": "synthetic",
    }

    def setUp(self):
        self.client = TestClient(server.app)
        self.addCleanup(self.client.close)
        self.headers = {"Authorization": "Bearer synthetic-token"}

    def document_requests(self):
        return [
            ("GET", f"/api/households/{self.HID}/pdf"),
            ("GET", "/api/households/export/pdf"),
            ("POST", f"/api/households/{self.HID}/save-to-drive"),
            ("POST", "/api/scan"),
        ]

    def send(self, method, path):
        return self.client.request(method, path, headers=self.headers)

    @contextmanager
    def env(self, cloud_run_url=AUD):
        env = {k: v for k, v in os.environ.items()
               if k not in ("CLOUD_RUN_URL", "POSITIONS_API_EXPECTED_AUDIENCE")}
        env.update(self.SCAN_ENV)
        if cloud_run_url is not None:
            env["CLOUD_RUN_URL"] = cloud_run_url
        with mock.patch.dict(os.environ, env, clear=True):
            yield

    @contextmanager
    def service_verifiers(self, sa):
        """PDF reads check the read allowlist, Drive save and scan the edit allowlist; one mock stands in for
        both so a call count covers every document route."""
        with mock.patch.object(server.pipeline_auth, "verify_households_api_token", sa), \
             mock.patch.object(server.pipeline_auth, "verify_ops_portal_edit_token", sa):
            yield sa

    @contextmanager
    def service_account(self, aud=None, cloud_run_url=AUD):
        claims = {"aud": aud or self.AUD, "email": self.SA}
        with self.env(cloud_run_url), \
             mock.patch.object(server.pipeline_auth, "verify_web_user_token",
                               side_effect=server.pipeline_auth.AuthError(401, "Token audience not accepted")), \
             mock.patch.object(server.pipeline_auth, "verify_google_id_token", return_value=claims), \
             self.service_verifiers(mock.Mock(return_value=self.SA)) as sa:
            yield sa

    @contextmanager
    def web_user(self, role):
        user = {"email": f"{role}@example.invalid", "role": role}
        with self.env(), \
             mock.patch.object(server.pipeline_auth, "verify_web_user_token", return_value=user), \
             self.service_verifiers(mock.Mock()) as sa:
            yield sa

    @contextmanager
    def backends(self):
        household = {"id": self.HID, "client_name": "Synthetic Client", "accounts": []}
        with mock.patch.object(db, "get_connection", return_value=object()) as connect, \
             mock.patch.object(db, "put_connection"), \
             mock.patch.object(db, "get_household_detail", return_value=household), \
             mock.patch.object(db, "get_households", return_value=[{"id": self.HID}]), \
             mock.patch.object(server, "generate_household_pdf", return_value=b"%PDF-synthetic"), \
             mock.patch.object(server, "generate_all_households_pdf", return_value=b"%PDF-synthetic-all"), \
             mock.patch.object(server, "build_google_services", return_value=object()), \
             mock.patch.object(server, "get_or_create_subfolder", return_value="synthetic-folder"), \
             mock.patch.object(server, "upload_pdf_to_folder",
                               return_value={"id": "synthetic-file", "webViewLink": "https://drive.example.test/f"}), \
             mock.patch.object(db, "mark_household_reviewed",
                               return_value=datetime(2026, 10, 4, 13, 0, 0)) as reviewed, \
             mock.patch.object(server, "run_once", return_value=[{"client": "a"}, {"client": "b"}]) as scan:
            yield SimpleNamespace(connect=connect, reviewed=reviewed, scan=scan)

    def test_service_account_can_call_each_document_route(self):
        with self.service_account(), self.backends():
            codes = [self.send(m, p).status_code for m, p in self.document_requests()]
        self.assertEqual(codes, [200] * 4)

    def test_pdf_routes_return_pdf_bytes_to_the_service_account(self):
        with self.service_account(), self.backends():
            responses = [self.send(m, p) for m, p in self.document_requests()[:2]]
        for r in responses:
            self.assertEqual(r.headers["content-type"], "application/pdf")
            self.assertTrue(r.content.startswith(b"%PDF"))
            self.assertIn("attachment; filename=", r.headers["content-disposition"])

    def test_drive_save_records_the_service_account_as_reviewer(self):
        with self.service_account(), self.backends() as b:
            body = self.send(*self.document_requests()[2]).json()
        self.assertEqual(b.reviewed.call_args.args[2], self.SA)
        self.assertEqual(body["reviewed_by"], self.SA)
        self.assertEqual(body["reviewed_at"], "2026-10-04T13:00:00")
        self.assertEqual(body["web_view_link"], "https://drive.example.test/f")
        self.assertTrue(body["filename"].endswith(".pdf"))

    def test_manual_scan_returns_the_client_count(self):
        with self.service_account(), self.backends() as b:
            body = self.send(*self.document_requests()[3]).json()
        self.assertEqual(body["clients_processed"], 2)
        b.scan.assert_called_once()

    def test_manual_scan_while_running_returns_409(self):
        self.assertTrue(server._scan_lock.acquire(blocking=False))
        try:
            with self.service_account(), self.backends() as b:
                response = self.send(*self.document_requests()[3])
        finally:
            server._scan_lock.release()
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"], "A scan is already in progress")
        b.scan.assert_not_called()

    def test_any_web_user_still_gets_both_pdfs(self):
        with self.web_user("advisor") as sa, self.backends():
            codes = [self.send(m, p).status_code for m, p in self.document_requests()[:2]]
        self.assertEqual(codes, [200, 200])
        sa.assert_not_called()

    def test_advisor_web_user_is_rejected_on_drive_and_scan(self):
        with self.web_user("advisor"), self.backends() as b:
            codes = [self.send(m, p).status_code for m, p in self.document_requests()[2:]]
        self.assertEqual(codes, [403, 403])
        b.reviewed.assert_not_called()
        b.scan.assert_not_called()

    def test_ops_web_user_is_still_accepted_on_drive_and_scan(self):
        with self.web_user("ops") as sa, self.backends() as b:
            codes = [self.send(m, p).status_code for m, p in self.document_requests()[2:]]
        self.assertEqual(codes, [200, 200])
        sa.assert_not_called()
        self.assertEqual(b.reviewed.call_args.args[2], "ops@example.invalid")

    def test_wrong_audience_is_rejected_on_every_document_route(self):
        with self.service_account(aud="https://other-service.example.test") as sa, self.backends() as b:
            responses = [self.send(m, p) for m, p in self.document_requests()]
        self.assertEqual([r.status_code for r in responses], [401] * 4)
        self.assertEqual(responses[0].json()["detail"], "Token audience not accepted")
        sa.assert_not_called()
        b.connect.assert_not_called()

    def test_no_audience_configured_is_rejected_on_every_document_route(self):
        with self.service_account(cloud_run_url=None) as sa, self.backends() as b:
            codes = [self.send(m, p).status_code for m, p in self.document_requests()]
        self.assertEqual(codes, [401] * 4)
        sa.assert_not_called()
        b.connect.assert_not_called()

    def test_unlisted_service_account_is_rejected_on_every_document_route(self):
        claims = {"aud": self.AUD, "email": "unlisted@synthetic.iam.gserviceaccount.com"}
        with self.env(), \
             mock.patch.object(server.pipeline_auth, "verify_web_user_token",
                               side_effect=server.pipeline_auth.AuthError(401, "Token audience not accepted")), \
             mock.patch.object(server.pipeline_auth, "verify_google_id_token", return_value=claims), \
             self.service_verifiers(mock.Mock(side_effect=server.pipeline_auth.AuthError(
                 403, "Service account not authorized"))) as sa, \
             self.backends() as b:
            responses = [self.send(m, p) for m, p in self.document_requests()]
        self.assertEqual([r.status_code for r in responses], [401] * 4)
        self.assertEqual(responses[0].json()["detail"], "Token audience not accepted")
        self.assertEqual(sa.call_count, 4)
        b.connect.assert_not_called()
        b.scan.assert_not_called()


if __name__ == "__main__":
    unittest.main()

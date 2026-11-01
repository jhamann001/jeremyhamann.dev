"""The imported code's auth findings, fixed: every machine check fails closed, web sign-in needs a verified
email, edits have their own allowlist, the scan secret compares in constant time, and Drive folder queries
escape backslashes."""
from types import SimpleNamespace
from unittest import mock

import pytest
from fastapi import HTTPException

import auth
import automation_pipeline as ap
import server

SCHEDULER = "scheduler@synthetic-project.iam.gserviceaccount.com"
READER = "reader@synthetic-project.iam.gserviceaccount.com"
EDITOR = "editor@synthetic-project.iam.gserviceaccount.com"
SERVICE = "https://pipeline.example.test"
MACHINE_ENV = ("SCAN_ALLOWED_SA", "SCAN_EXPECTED_AUDIENCE", "POSITIONS_API_ALLOWED_SAS",
               "POSITIONS_API_EXPECTED_AUDIENCE", "OPS_PORTAL_EDIT_ALLOWED_SAS", "CLOUD_RUN_URL",
               "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_APPS_SCRIPT_CLIENT_ID", "DEMO_MODE")


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for key in MACHINE_ENV:
        monkeypatch.delenv(key, raising=False)


def google(claims):
    return mock.patch.object(auth, "verify_google_id_token", return_value=claims)


# ---------------------------------------------------------------------------
# /scan: fails closed
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("settings", [{}, {"SCAN_ALLOWED_SA": SCHEDULER}, {"SCAN_EXPECTED_AUDIENCE": SERVICE}])
def test_scan_refuses_every_token_until_both_settings_are_set(monkeypatch, settings):
    for key, value in settings.items():
        monkeypatch.setenv(key, value)
    with google({"aud": SERVICE, "email": SCHEDULER}) as verify:
        with pytest.raises(auth.AuthError) as refused:
            auth.verify_scan_caller_token("synthetic-token")
    assert refused.value.status_code == 503
    verify.assert_not_called()


def test_scan_checks_audience_and_caller(monkeypatch):
    monkeypatch.setenv("SCAN_ALLOWED_SA", SCHEDULER)
    monkeypatch.setenv("SCAN_EXPECTED_AUDIENCE", f"{SERVICE}/scan, {SERVICE}")
    with google({"aud": f"{SERVICE}/scan", "email": SCHEDULER}):
        assert auth.verify_scan_caller_token("t") == SCHEDULER
    for claims in ({"aud": "https://other.example.test", "email": SCHEDULER},
                   {"aud": SERVICE, "email": READER}):
        with google(claims), pytest.raises(auth.AuthError) as refused:
            auth.verify_scan_caller_token("t")
        assert refused.value.status_code == 403


def test_scan_route_refuses_an_unconfigured_token_before_scanning(monkeypatch):
    request = SimpleNamespace(headers={"Authorization": "Bearer synthetic-token"})
    with google({"aud": SERVICE, "email": SCHEDULER}), pytest.raises(HTTPException) as refused:
        server._verify_scan_caller(request)
    assert refused.value.status_code == 403


def test_scan_secret_compares_exactly(monkeypatch):
    monkeypatch.setattr(server, "SCAN_SECRET", "synthetic-scan-secret")
    server._verify_scan_caller(SimpleNamespace(headers={"X-Scan-Secret": "synthetic-scan-secret"}))
    for wrong in ("synthetic-scan-secreT", "synthetic-scan-secret ", "é"):
        with pytest.raises(HTTPException) as refused:
            server._verify_scan_caller(SimpleNamespace(headers={"X-Scan-Secret": wrong}))
        assert refused.value.status_code == 403
    monkeypatch.setattr(server, "SCAN_SECRET", "")
    with pytest.raises(HTTPException):
        server._verify_scan_caller(SimpleNamespace(headers={"X-Scan-Secret": ""}))


# ---------------------------------------------------------------------------
# Web sign-in: a verified email
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("verified", [None, False, "true", 1])
def test_web_sign_in_refuses_an_unverified_email(monkeypatch, verified):
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_ID", "synthetic-client")
    claims = {"aud": "synthetic-client", "email": "ops@example.invalid"}
    if verified is not None:
        claims["email_verified"] = verified
    with google(claims), mock.patch.object(auth, "load_user_or_raise") as load:
        with pytest.raises(auth.AuthError) as refused:
            auth.verify_web_user_token("t")
    assert refused.value.status_code == 401
    load.assert_not_called()


def test_web_sign_in_accepts_a_verified_email(monkeypatch):
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_ID", "synthetic-client")
    claims = {"aud": "synthetic-client", "email": "Ops@Example.invalid", "email_verified": True}
    with google(claims), mock.patch.object(auth, "load_user_or_raise",
                                           return_value={"email": "ops@example.invalid", "role": "ops"}) as load:
        assert auth.verify_web_user_token("t")["role"] == "ops"
    load.assert_called_once_with("ops@example.invalid")


# ---------------------------------------------------------------------------
# Machine APIs: audience required; edits have their own allowlist
# ---------------------------------------------------------------------------

VERIFIERS = (auth.verify_positions_api_token, auth.verify_households_api_token, auth.verify_ops_portal_edit_token)


@pytest.mark.parametrize("verifier", VERIFIERS)
def test_machine_callers_need_an_audience(monkeypatch, verifier):
    monkeypatch.setenv("POSITIONS_API_ALLOWED_SAS", READER)
    monkeypatch.setenv("OPS_PORTAL_EDIT_ALLOWED_SAS", EDITOR)
    with google({"aud": "anything", "email": READER}) as verify, pytest.raises(auth.AuthError) as refused:
        verifier("t")
    assert refused.value.status_code == 503
    verify.assert_not_called()


def test_audience_falls_back_to_this_service_and_ignores_a_trailing_slash(monkeypatch):
    monkeypatch.setenv("POSITIONS_API_ALLOWED_SAS", READER)
    monkeypatch.setenv("CLOUD_RUN_URL", SERVICE + "/")
    with google({"aud": SERVICE, "email": READER}):
        assert auth.verify_positions_api_token("t") == READER
    with google({"aud": "https://other.example.test", "email": READER}), pytest.raises(auth.AuthError) as wrong:
        auth.verify_households_api_token("t")
    assert wrong.value.status_code == 403
    monkeypatch.setenv("POSITIONS_API_EXPECTED_AUDIENCE", "https://alias.example.test")
    with google({"aud": SERVICE, "email": READER}), pytest.raises(auth.AuthError):
        auth.verify_positions_api_token("t")  # the explicit setting replaces the fallback


def test_a_reader_cannot_edit_and_an_editor_cannot_read(monkeypatch):
    monkeypatch.setenv("CLOUD_RUN_URL", SERVICE)
    monkeypatch.setenv("POSITIONS_API_ALLOWED_SAS", READER)
    monkeypatch.setenv("OPS_PORTAL_EDIT_ALLOWED_SAS", EDITOR)
    with google({"aud": SERVICE, "email": READER}):
        assert auth.verify_households_api_token("t") == READER
        with pytest.raises(auth.AuthError):
            auth.verify_ops_portal_edit_token("t")
    with google({"aud": SERVICE, "email": EDITOR}):
        assert auth.verify_ops_portal_edit_token("t") == EDITOR
        with pytest.raises(auth.AuthError):
            auth.verify_positions_api_token("t")


def test_edits_are_refused_while_the_edit_allowlist_is_unset(monkeypatch):
    monkeypatch.setenv("CLOUD_RUN_URL", SERVICE)
    monkeypatch.setenv("POSITIONS_API_ALLOWED_SAS", f"{READER},{EDITOR}")
    with google({"aud": SERVICE, "email": READER}), pytest.raises(auth.AuthError) as refused:
        auth.verify_ops_portal_edit_token("t")
    assert refused.value.status_code == 503


def test_the_edit_routes_take_a_reader_only_through_the_read_routes(monkeypatch):
    monkeypatch.setenv("CLOUD_RUN_URL", SERVICE)
    monkeypatch.setenv("POSITIONS_API_ALLOWED_SAS", READER)
    with google({"aud": SERVICE, "email": READER}):
        assert server._verify_ops_portal_service_account("t", edit=False) == READER
        assert server._verify_ops_portal_service_account("t", edit=True) is None


# ---------------------------------------------------------------------------
# Drive folder query
# ---------------------------------------------------------------------------

def drive_literal(q: str, field: str) -> str:
    """The value of `field = '...'` in a Drive query, unescaped the way Drive reads it."""
    start = q.index(f"{field} = '") + len(field) + 4
    out, i = [], start
    while q[i] != "'":
        if q[i] == "\\":
            i += 1
        out.append(q[i])
        i += 1
    rest = q[i + 1:]
    assert rest.startswith(" and mimeType = "), rest  # nothing in the name leaked into the query
    return "".join(out)


@pytest.mark.parametrize("name", ["Ken Nakamura", "O'Brien Trust", "Ends with \\", "a\\' or name contains '",
                                  "\\\\'"])
def test_drive_folder_names_cannot_escape_their_quotes(name):
    files = mock.MagicMock()
    files.list.return_value.execute.return_value = {"files": [{"id": "existing"}]}
    drive = SimpleNamespace(files=lambda: files)
    assert ap.get_or_create_subfolder(drive, "parent-id", name) == "existing"
    q = files.list.call_args.kwargs["q"]
    assert q.startswith("'parent-id' in parents and ")
    assert drive_literal(q, "name") == name

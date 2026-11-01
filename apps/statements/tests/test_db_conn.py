"""db._conn_kwargs: unchanged by default; validated sslmode/search_path; prefixed families."""
import pytest

import db
from tests.flywheel import mark_case

SUITE = "db-conn"
FAMILY = ("HOST", "PORT", "NAME", "USER", "PASSWORD", "IAM_AUTH", "SSLMODE", "SEARCH_PATH")


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for prefix in ("DB_", "TARGET_DB_", "SOURCE_DB_"):
        for name in FAMILY:
            monkeypatch.delenv(prefix + name, raising=False)


def test_defaults_unchanged(monkeypatch):
    monkeypatch.setenv("DB_HOST", "/cloudsql/p:r:i")
    monkeypatch.setenv("DB_PASSWORD", "pw")
    assert db._conn_kwargs() == dict(dbname="acat", user="statement_pipeline", password="pw", host="/cloudsql/p:r:i")
    monkeypatch.setenv("DB_HOST", "10.0.0.5")
    assert db._conn_kwargs() == dict(host="10.0.0.5", port="5432", dbname="acat", user="statement_pipeline", password="pw")
    mark_case(SUITE, "defaults-unchanged")


def test_sslmode_and_search_path(monkeypatch):
    monkeypatch.setenv("DB_HOST", "10.0.0.6")
    monkeypatch.setenv("DB_SSLMODE", "require")
    monkeypatch.setenv("DB_SEARCH_PATH", "statement_pipeline")
    kwargs = db._conn_kwargs()
    assert kwargs["sslmode"] == "require"
    assert kwargs["options"] == "-c search_path=statement_pipeline"
    mark_case(SUITE, "sslmode-and-search-path")


@pytest.mark.parametrize("name,value", [
    ("DB_SSLMODE", "required"),
    ("DB_SEARCH_PATH", "statement_pipeline,public"),
    ("DB_SEARCH_PATH", "Acat"),
    ("DB_SEARCH_PATH", "x -c role=postgres"),
])
def test_rejects_unsafe_values(monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    with pytest.raises(ValueError):
        db._conn_kwargs()
    mark_case(SUITE, f"rejects-{name}-{value}")


def test_prefix_reads_only_its_family(monkeypatch):
    monkeypatch.setenv("DB_HOST", "10.0.0.7")
    monkeypatch.setenv("TARGET_DB_HOST", "10.0.0.6")
    monkeypatch.setenv("TARGET_DB_NAME", "opsPortal")
    monkeypatch.setenv("TARGET_DB_USER", "statement_pipeline_rw")
    kwargs = db._conn_kwargs("TARGET_DB_")
    assert (kwargs["host"], kwargs["dbname"], kwargs["user"]) == ("10.0.0.6", "opsPortal", "statement_pipeline_rw")
    assert db._conn_kwargs()["host"] == "10.0.0.7"
    mark_case(SUITE, "prefix-family")

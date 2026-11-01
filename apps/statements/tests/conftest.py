"""Disposable pipeline schemas in TEST_DATABASE_URL for the database tests."""
import os
from uuid import uuid4

import psycopg2
import pytest
from psycopg2 import sql

import db


@pytest.fixture
def pg():
    dsn = os.environ.get("TEST_DATABASE_URL")
    if not dsn:
        pytest.skip("Requires explicit disposable TEST_DATABASE_URL")
    admin = psycopg2.connect(dsn)
    admin.autocommit = True
    created, roles = [], []

    def schema(*, ddl: bool = True) -> str:
        name = "ops_portal_db_test_" + uuid4().hex
        with admin.cursor() as cur:
            cur.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(name)))
            created.append(name)
            if ddl:
                cur.execute(sql.SQL("SET search_path TO {}").format(sql.Identifier(name)))
                cur.execute(db._TABLES_SQL)
                cur.execute(db._MIGRATION_SQL)
                cur.execute(db._VIEWS_SQL)
                cur.execute("SET search_path TO DEFAULT")
        return name

    def login(schema_name: str) -> tuple:
        """A login with DML and TRUNCATE on the schema's tables and no CREATE, like statement_pipeline_rw."""
        name, password = "ops_portal_db_test_rw_" + uuid4().hex[:12], uuid4().hex
        with admin.cursor() as cur:
            cur.execute(sql.SQL("CREATE ROLE {} LOGIN PASSWORD %s").format(sql.Identifier(name)), (password,))
            roles.append(name)
            cur.execute(sql.SQL("GRANT USAGE ON SCHEMA {} TO {}").format(sql.Identifier(schema_name), sql.Identifier(name)))
            cur.execute(sql.SQL("GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA {} TO {}").format(
                sql.Identifier(schema_name), sql.Identifier(name)))
        return name, password

    def env(prefix: str, schema_name: str, as_login: tuple = None) -> dict:
        info = admin.info
        user, password = as_login or (info.user, info.password or "")
        return {
            prefix + "HOST": info.host,
            prefix + "PORT": str(info.port),
            prefix + "NAME": info.dbname,
            prefix + "USER": user,
            prefix + "PASSWORD": password,
            prefix + "IAM_AUTH": "false",
            prefix + "SEARCH_PATH": schema_name,
        }

    def execute(schema_name: str, statement: str, params=None) -> None:
        with admin.cursor() as cur:
            cur.execute(sql.SQL("SET search_path TO {}").format(sql.Identifier(schema_name)))
            cur.execute(statement, params)
            cur.execute("SET search_path TO DEFAULT")

    def fetch(schema_name: str, query: str):
        with admin.cursor() as cur:
            cur.execute(sql.SQL("SET search_path TO {}").format(sql.Identifier(schema_name)))
            cur.execute(query)
            rows = cur.fetchall()
            cur.execute("SET search_path TO DEFAULT")
        return rows

    try:
        yield {"schema": schema, "login": login, "env": env, "execute": execute, "fetch": fetch}
    finally:
        with admin.cursor() as cur:
            for name in created:
                cur.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(name)))
            for name in roles:
                cur.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(name)))
        admin.close()

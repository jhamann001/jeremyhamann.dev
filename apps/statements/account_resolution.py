"""Resolve source accounts across runs without merging different registrations.

Rows include deleted versions: the newest deletion is a tombstone, not a reason
to fall back to older holdings. Names are search/display context, never an
automatic substitute for an account identifier.
"""
import re


class AccountSelectionRequired(ValueError):
    pass


def normalize_number(value):
    return re.sub(r"[\s-]", "", value or "").upper()


def _text(value):
    return " ".join((value or "").upper().split())


def family(account):
    return account.get("lineage_key") or account.get("source_folder_id") or str(account["household_id"])


def identity(account):
    prefix = (family(account), _text(account.get("custodian")))
    number = normalize_number(account.get("account_number"))
    if number:
        return (*prefix, "number", number)
    investor = normalize_number(account.get("investor_number"))
    registration = _text(account.get("account_registration"))
    holder = _text(account.get("account_holder"))
    if investor and registration and holder:
        return (*prefix, "registration", investor, registration, holder)
    # Legacy numberless rows cannot be linked across runs by names/type alone.
    return (*prefix, "unlinked", str(account["id"]))


def has_newer_numberless_registration(account, versions):
    if not account.get("superseded_by"):
        return False
    if identity(account)[2] == "registration":
        return False  # A known investor + registration remains a distinct account.
    holder = _text(account.get("account_holder"))
    custodian = _text(account.get("custodian"))
    if not holder or not custodian:
        return False
    return any(
        family(other) == family(account)
        and other["processed_at"] > account["processed_at"]
        and not normalize_number(other.get("account_number"))
        and _text(other.get("custodian")) == custodian
        and _text(other.get("account_holder")) == holder
        and identity(other) != identity(account)
        for other in versions
    )


def latest_accounts(versions):
    """Keep newest run per identity, retaining same-run duplicates as ambiguity."""
    groups = {}
    for account in sorted(versions, key=lambda a: (a["processed_at"], a.get("run_number") or 0), reverse=True):
        if account.get("superseded_by") and not (account.get("source_folder_id") or account.get("lineage_key")):
            continue  # No reliable household lineage for this orphaned run.
        key = identity(account)
        group = groups.setdefault(key, [])
        if (not group or group[0]["household_id"] == account["household_id"]
                or (group[0]["processed_at"], group[0].get("run_number")) == (account["processed_at"], account.get("run_number"))):
            group.append(account)
    numbered = {}
    for account in versions:
        number = normalize_number(account.get("account_number"))
        if number:
            numbered.setdefault((family(account), number), []).append(account)
    deleted_numbers = set()
    for key, accounts in numbered.items():
        newest = max(a["processed_at"] for a in accounts)
        if all(a.get("deleted_at") for a in accounts if a["processed_at"] == newest):
            deleted_numbers.add(key)
    return [a for group in groups.values() for a in group if not a.get("deleted_at")
            and (family(a), normalize_number(a.get("account_number"))) not in deleted_numbers]


def resolve_account(versions, *, account_number=None, account_id=None):
    latest = latest_accounts(versions)
    if account_id:
        selected = next((a for a in versions if str(a["id"]) == account_id), None)
        if not selected or selected.get("deleted_at"):
            return None
        matches = [a for a in latest if identity(a) == identity(selected)]
        number = normalize_number(selected.get("account_number"))
        current = [a for a in latest if number and not a.get("superseded_by")
                   and family(a) == family(selected)
                   and normalize_number(a.get("account_number")) == number]
        if current:
            matches = current
        if any(str(a["id"]) == account_id for a in matches):
            matches = [selected]  # Explicit selection disambiguates this exact version.
    else:
        number = normalize_number(account_number)
        if not number or any(c in number for c in "*•●"):
            return None
        matches = [a for a in latest if normalize_number(a.get("account_number")) == number]
        current = [a for a in matches if not a.get("superseded_by")]
        if current:
            matches = current  # Existing unambiguous live lookups keep their contract.
        # An investor number is shared by registrations. Always require a choice.
        if not matches and any(normalize_number(a.get("investor_number")) == number for a in latest):
            raise AccountSelectionRequired("Choose the source account registration for this investor number")
    if len(matches) > 1:
        raise AccountSelectionRequired("Multiple source accounts match; choose the account registration")
    if not matches:
        return None
    account = matches[0]
    if has_newer_numberless_registration(account, versions):
        raise AccountSelectionRequired("Newer source registrations need an explicit account selection")
    return account


def account_choices(versions):
    latest = latest_accounts(versions)
    current_numbers = {(family(a), normalize_number(a.get("account_number"))) for a in latest if not a.get("superseded_by") and normalize_number(a.get("account_number"))}
    return [a for a in latest if not has_newer_numberless_registration(a, versions)
            and not (a.get("superseded_by") and (family(a), normalize_number(a.get("account_number"))) in current_numbers)]

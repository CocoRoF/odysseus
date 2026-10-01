"""관리자 둘러보기 계정의 경계 — 무엇을 읽고, 무엇을 거절하는가 (odysseus_api/demo.py)."""

import pathlib
import sys
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "apps" / "api"))

from odysseus_api.demo import (  # noqa: E402
    DEMO_ADMIN_ROLE,
    is_demo_admin,
    mask_email,
    mask_email_for,
    readonly_violation,
)
from odysseus_api.deps import STAFF_ROLES  # noqa: E402
from odysseus_api.guests import GuestPolicy  # noqa: E402


class Viewer:
    def __init__(self, role: str):
        self.role = role


class ReadOnlyGuardTests(unittest.TestCase):
    def test_reading_is_allowed_everywhere(self):
        for method in ("GET", "HEAD", "OPTIONS", "get"):
            self.assertFalse(readonly_violation(DEMO_ADMIN_ROLE, method, "/admin/users"))

    def test_every_change_is_refused(self):
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            for path in ("/admin/scenarios", "/attempts", "/admin/access/guest", "/auth/guest"):
                self.assertTrue(readonly_violation(DEMO_ADMIN_ROLE, method, path), (method, path))

    def test_logout_stays_open(self):
        # 나가는 길까지 막으면 세션이 만료될 때까지 갇힌다.
        self.assertFalse(readonly_violation(DEMO_ADMIN_ROLE, "POST", "/auth/logout"))
        self.assertFalse(readonly_violation(DEMO_ADMIN_ROLE, "POST", "/auth/logout/"))

    def test_other_roles_are_untouched(self):
        for role in ("admin", "evaluator", "candidate", "guest"):
            self.assertFalse(readonly_violation(role, "DELETE", "/admin/users/1"))

    def test_demo_reads_staff_screens(self):
        # 관리·리뷰 화면의 조회는 관리자와 같은 자리에서 본다.
        self.assertIn(DEMO_ADMIN_ROLE, STAFF_ROLES)
        self.assertTrue(is_demo_admin(Viewer(DEMO_ADMIN_ROLE)))
        self.assertFalse(is_demo_admin(Viewer("admin")))


class MaskEmailTests(unittest.TestCase):
    def test_local_part_is_hidden_and_length_is_not_leaked(self):
        self.assertEqual(mask_email("candidate@odysseus.dev"), "ca***@odysseus.dev")
        self.assertEqual(mask_email("a@b.com"), "a***@b.com")
        self.assertEqual(mask_email(""), "")
        self.assertEqual(mask_email("broken"), "***")

    def test_only_the_demo_viewer_sees_masked_addresses(self):
        self.assertEqual(mask_email_for(Viewer("admin"), "x@y.dev"), "x@y.dev")
        self.assertEqual(mask_email_for(Viewer("evaluator"), "x@y.dev"), "x@y.dev")
        self.assertEqual(mask_email_for(Viewer(DEMO_ADMIN_ROLE), "x@y.dev"), "x***@y.dev")


class PolicyTests(unittest.TestCase):
    def test_browsing_is_off_until_it_is_turned_on(self):
        self.assertFalse(GuestPolicy().admin_demo_enabled)
        # 게스트 응시와 별개 스위치다 — 하나를 켜도 다른 하나는 켜지지 않는다.
        self.assertFalse(GuestPolicy.from_value({"enabled": True}).admin_demo_enabled)
        self.assertFalse(GuestPolicy.from_value({"admin_demo_enabled": True}).enabled)

    def test_policy_round_trips_through_storage(self):
        policy = GuestPolicy.from_value({"enabled": True, "admin_demo_enabled": True})
        self.assertTrue(GuestPolicy.from_value(policy.to_value()).admin_demo_enabled)


if __name__ == "__main__":
    unittest.main()

/** 방 하나(=시험 하나)가 감당할 크기.
 *
 *  시나리오를 여럿 묶으면 그 인물이 전부 한 방에 서서 방이 사람으로 꽉 찬다 — 서로를 가려 누가 있는지 읽히지 않는다.
 *  그래서 두 군데서 막는다: 시험에 넣는 시나리오 수와, 방에 세우는 동료 수.
 *
 *  API 의 odysseus_api/office.py 와 **같은 값**이어야 한다(tests/unit/test_assessment_limits.py 가 맞대 본다).
 */
export const MAX_SCENARIOS_PER_ASSESSMENT = 1;
export const MAX_COLLEAGUES = 6;

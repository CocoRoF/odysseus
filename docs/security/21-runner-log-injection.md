# ODY-021: 응시자 명령을 이용한 러너 로그 인젝션

## 취약점 요약

- **심각도:** 중간
- **영향:** 로그 줄 위조, 탐지 우회, 운영자 터미널 표시 교란, 잘못된 사고 대응
- **원인:** 응시자가 제어하는 command를 개행·제어문자 escape 없이 `print()`에 삽입한다.
- **주요 근거:** `apps/api/odysseus_api/routers/executions.py:33`, `apps/api/odysseus_api/routers/executions.py:42`, `apps/runner/worker.py:222`

## 상세

실행 API는 command 앞뒤 whitespace만 `strip()`하며 내부 newline, carriage return, tab, ESC 등 제어문자를 허용한다. runner는 처리 완료 후 command의 첫 60자를 f-string에 그대로 넣어 표준 출력으로 기록한다.

Docker/Journald/텍스트 수집기가 줄 단위로 로그를 처리하면 내부 newline은 별도 정상 로그처럼 보일 수 있다. 운영자가 ANSI를 해석하는 terminal에서 로그를 보면 색상, 커서 이동, 화면 지우기 같은 escape sequence가 표시를 교란할 수 있다.

## 재현 방법(공격 방법)

본인 로컬 테스트 실행에 harmless marker만 사용한다.

```bash
curl -sS -b "$COOKIE_JAR" \
  -H 'Content-Type: application/json' \
  -d '{"command":"true\n[runner] FORGED_TEST_LINE exit=0"}' \
  "$BASE_URL/attempts/$ATTEMPT_ID/scenarios/$SCENARIO_ID/run"

docker compose logs runner --tail=20
```

`FORGED_TEST_LINE`이 별도 runner 로그처럼 표시되면 재현된다. 화면 삭제 ANSI 코드는 공유 터미널에서 시험하지 않는다.

## 공격 예시

1. **성공 로그 위조:** 명령에 newline과 `[runner] ... exit=0`을 넣어 실패 실행이 성공한 것처럼 보이는 줄을 만든다.
2. **경보 위장:** `unauthorized`, `killed`, `internal error` 같은 가짜 운영 메시지를 삽입해 실제 장애로 오인하게 한다.
3. **ANSI 표시 교란:** ESC sequence로 글자색을 숨기거나 이전 줄을 덮어 운영자가 악성 명령을 놓치게 한다.
4. **로그 parser 혼란:** 탭·carriage return·비정상 Unicode를 넣어 SIEM field parsing과 검색을 방해한다.

## 해결 방법

1. 문자열 연결 로그 대신 JSON 구조화 logging을 사용하고 command는 JSON encoder가 escape하게 한다.
2. 표시용 command는 `repr()` 또는 전용 control-character sanitizer를 통과시킨다.
3. 원본 command 전문은 접근 제한된 감사 저장소에 보관하고 일반 운영 로그에는 execution ID와 해시만 남긴다.
4. `\r`, `\n`, C0/C1 control 및 bidi 제어문자를 입력 단계에서 거부하거나 명시적으로 escape한다.
5. 로그 수집기에서 multiline 이벤트를 임의 합치지 말고 예상 schema와 service identity를 검증한다.
6. 운영자 UI는 텍스트 렌더링만 사용하고 ANSI/HTML을 해석하지 않는다.


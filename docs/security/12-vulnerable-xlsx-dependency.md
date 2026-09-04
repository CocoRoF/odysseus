# ODY-012: 취약한 xlsx 0.18.5 의존성

## 취약점 요약

- **심각도:** 높음
- **영향:** 관리자 브라우저의 prototype pollution, 악성 spreadsheet 처리 시 UI 오작동 또는 DoS
- **원인:** 알려진 취약점이 있는 `xlsx@^0.18.5`로 관리자 업로드 파일을 브라우저에서 파싱한다.
- **주요 근거:** `apps/web/package.json:19`, `apps/web/app/admin/users/new/page.tsx:119`
- **관련 권고:** [CVE-2023-30533](https://cdn.sheetjs.com/advisories/CVE-2023-30533), [CVE-2024-22363](https://cdn.sheetjs.com/advisories/CVE-2024-22363)

## 상세

관리자 사용자 일괄 등록 화면은 업로드한 `.xlsx`, `.xls`, `.csv`를 `xlsx` 라이브러리로 읽는다. 설치 범위 `^0.18.5`는 npm에 마지막으로 공개된 0.18.5 계열이며, SheetJS 공식 권고에 따르면 이 버전은 다음 문제의 영향 범위에 포함된다.

- CVE-2023-30533: 조작된 파일을 읽을 때 prototype pollution. 0.19.3에서 수정.
- CVE-2024-22363: 정규식 서비스 거부(ReDoS). 0.20.2에서 수정.

파일을 올리는 주체는 보통 관리자지만, 응시자 명단 파일을 이메일·메신저·공유 드라이브 등 외부에서 전달받는 업무 흐름이 있으면 사회공학을 통해 공격이 가능하다.

## 재현 방법(공격 방법)

공개 exploit workbook을 운영 관리자에게 전달하지 않는다. 격리된 테스트 브라우저에서 다음을 확인한다.

1. `npm ls xlsx` 또는 빌드 메타데이터로 실제 설치 버전을 확인한다.
2. 공식 권고의 영향 버전과 비교한다.
3. 테스트용 큰/복잡한 workbook을 업로드하면서 브라우저 CPU·응답성을 관찰한다.
4. prototype pollution은 공식 회귀 테스트 또는 공급자가 제공한 안전한 테스트 fixture로만 검증한다.

```bash
cd apps/web
npm ls xlsx
```

lockfile이 없으므로 새 설치 전에는 별도 임시 디렉터리나 CI에서 확인하는 것이 안전하다.

## 공격 예시

1. **악성 명단 파일 전달:** 공격자가 “최종 응시자 명단”으로 위장한 workbook을 관리자에게 보내 업로드하게 한다.
2. **ReDoS 유발:** 비정상적으로 구성된 cell/format 문자열을 가진 파일로 관리자 탭의 메인 스레드를 장시간 점유한다.
3. **Prototype pollution:** 특수 workbook 구조를 통해 JavaScript 객체 prototype을 오염시켜 후속 UI 로직의 권한·속성 검사를 비정상 동작하게 한다.
4. **대용량 파싱과 결합:** 정상 압축 크기는 작지만 내부 구조가 큰 workbook으로 브라우저 메모리와 취약 정규식 비용을 동시에 증가시킨다.

## 해결 방법

1. SheetJS CE 0.20.2 이상처럼 두 공식 권고가 수정된 버전으로 전환하고 출처·무결성·라이선스를 검토한다.
2. 또는 보안 유지가 명확한 다른 spreadsheet parser로 교체한다.
3. 업로드 크기, sheet 수, row/column 수, 압축 해제 비율에 사전 제한을 둔다.
4. 파싱을 Web Worker나 격리된 서버 프로세스에서 실행하고 시간·메모리 제한을 둔다.
5. `.csv`만으로 업무 요구가 충족되면 복잡한 workbook 형식을 비활성화한다.
6. lockfile과 SCA를 CI에 추가해 취약 버전 재도입을 차단한다.


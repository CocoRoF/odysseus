# ODY-004: 러너 변경 수집기의 심볼릭 링크·특수 파일 처리

## 취약점 요약

- **심각도:** 높음
- **영향:** 컨테이너 파일 읽기, 워커 슬롯 무한 정지, 메모리 고갈
- **원인:** 실행 후 `os.walk()` 결과를 일반 파일로 가정하고 `getsize()` 후 일반 `open().read()`를 수행한다.
- **주요 근거:** `apps/runner/worker.py:91`, `apps/runner/worker.py:102`, `apps/runner/worker.py:105`

## 상세

응시자 명령이 끝난 뒤 `collect_changes()`가 작업 디렉터리를 순회한다. 이때 `lstat()`이나 `stat.S_ISREG()` 검사를 하지 않으며, 경로가 심볼릭 링크인지 FIFO인지 장치 파일인지 구분하지 않는다.

심볼릭 링크의 `getsize()`와 `open()`은 대상 파일을 따라가므로 runner 컨테이너에서 읽을 수 있는 파일이 응시 결과에 포함될 수 있다. FIFO는 writer가 없으면 읽기에서 멈추고, `/dev/zero` 같은 장치는 크기가 0으로 보이지만 EOF가 없어 무제한으로 읽는다. 변경 파일당 크기 제한은 읽기 전에 신뢰할 수 있는 일반 파일인지 확인하지 않기 때문에 방어가 되지 않는다.

## 재현 방법(공격 방법)

아래는 전용 로컬 runner에서만 실행한다. FIFO와 `/dev/zero` 예시는 워커를 멈추거나 OOM으로 종료할 수 있다.

비파괴적인 심볼릭 링크 읽기 확인:

```bash
ln -s /etc/passwd leaked.txt
true
```

실행 완료 후 워크스페이스에 `leaked.txt` 내용이 반영되거나 execution의 `changed_files`에 컨테이너 파일 내용이 포함되면 재현된다.

## 공격 예시

1. **읽을 수 있는 시스템 파일 유출:** `ln -s /etc/passwd output.txt`를 만들어 컨테이너 계정·환경 구조를 워크스페이스로 가져온다.
2. **FIFO 워커 고정:** `mkfifo result.txt`를 남겨 `collect_changes()`가 reader 대기 상태에서 영원히 멈추게 한다.
3. **무한 장치 읽기:** `ln -s /dev/zero result.txt`로 크기 검사를 통과한 뒤 무제한 읽기를 유발해 runner 컨테이너를 OOM으로 종료시킨다.
4. **TOCTOU 교체:** 크기 검사 직후 일반 파일을 링크나 특수 파일로 바꾸는 경쟁을 시도해 검사와 사용 대상이 달라지게 한다.

## 해결 방법

1. 디렉터리 파일 디스크립터 기준 `os.open(..., O_NOFOLLOW | O_NONBLOCK)`을 사용한다.
2. 열린 fd에 `fstat()`을 수행하고 `stat.S_ISREG()`인 파일만 읽는다.
3. 파일을 한 번에 읽지 말고 `MAX_CHANGED_FILE_BYTES + 1`까지만 제한적으로 읽는다.
4. 작업 디렉터리의 각 경로가 `realpath` 기준 루트 안에 있는지 검증하되, 검증과 open을 fd 기반으로 결합해 TOCTOU를 피한다.
5. 파일 수집에 별도 시간 제한을 두고 정해진 시간이 지나면 해당 작업을 실패 처리한다.
6. 심볼릭 링크, FIFO, 소켓, block/character device를 명시적으로 무시하고 보안 이벤트로 기록한다.


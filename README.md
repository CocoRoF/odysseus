<p align="center">
  <img src="apps/web/public/brand/odysseus-logo.png" alt="Odysseus" width="680">
</p>

<p align="center"><b>문제는 지문으로 주어지지 않습니다.</b></p>

<p align="center">
  Odysseus 는 실무 시뮬레이션으로 개발자를 평가합니다.<br>
  응시자는 OS 데스크톱을 닮은 시험장에 출근해, 동료와 대화하며 무엇을 해야 하는지 스스로 알아내고,<br>
  IDE·터미널·AI 에이전트로 실제 산출물을 만듭니다. 그 과정 전체가 평가입니다.
</p>

<br>

## 왜 시뮬레이션인가

코딩 테스트는 잘 정리된 문제를 줍니다. 실제 업무는 그렇지 않습니다. 요구사항은 여러 사람에게 흩어져 있고, 물어봐야 나오고, 어떤 것은 틀린 채로 전해지며, 결국 산출물로 증명해야 합니다.

Odysseus 의 시험 하나는 **상황**입니다. 출근한 첫날, 누군가의 다급한 메시지에서 시작해, 누구에게 무엇을 물어야 하는지 판단하고, 확인하고, 만들어 내는 과정을 봅니다. 채점의 중심은 요구사항을 얼마나 정확히 파악해 냈는가, 그리고 동료를 어떻게 대했는가입니다.

<br>

## 한 번의 시험

시험은 소설의 도입부처럼 시작합니다. 언제, 어디서, 당신은 누구이며, 방금 무슨 일이 벌어졌는지. 무엇을 해야 하는지는 적혀 있지 않습니다.

<p align="center"><img src="docs/screenshots/intro.png" width="880" alt="시험 도입부"></p>

**임무 시작**을 누르면 워크스테이션이 켜집니다. 화면에 흐르는 것은 연출이 아니라 이 시험의 실제 사양입니다.

<p align="center"><img src="docs/screenshots/boot-services.png" width="880" alt="부팅 화면"></p>

데스크톱이 밝아오면 메신저에 메시지가 와 있습니다. 기술을 모르는 PM 의 막연한 부탁입니다. 여기서부터는 응시자의 몫입니다.

<p align="center"><img src="docs/screenshots/messenger.png" width="880" alt="메신저"></p>

동료에게 캐물어 규칙을 알아내고, IDE 에서 고치고, 터미널에서 실행해 봅니다. 필요하면 AI 에이전트에게 맡깁니다. 무엇을 어떻게 시켰는지도 그대로 남습니다.

<p align="center"><img src="docs/screenshots/ide-agent.png" width="880" alt="IDE 와 AI 에이전트"></p>

<br>

## 시험장

창을 옮기고 늘리고 겹칠 수 있는 하나의 데스크톱. 메신저, IDE, 터미널, AI 에이전트, 폴더, GitHub, 인터넷의 일곱 앱이 있습니다.

<p align="center"><img src="docs/screenshots/desktop.png" width="880" alt="데스크톱"></p>

터미널은 Python·Node.js·Go·Java·C 를 갖춘 진짜 리눅스입니다. 참고 저장소는 `git clone` 으로 가져옵니다.

<p align="center"><img src="docs/screenshots/terminal.png" width="880" alt="터미널"></p>

참고 자료는 시험장 안에서 찾습니다. GitHub 앱은 저장소를 검색해 읽고 가져오며, 인터넷 앱은 검색 결과를 실제 페이지 모양 그대로 보여 줍니다. 무엇을 찾아봤는지도 평가 자료가 됩니다.

<p align="center"><img src="docs/screenshots/internet-page.png" width="880" alt="인터넷 앱"></p>

<br>

## 동료들

등장인물은 어시스턴트가 아니라 **동료**입니다. 각자 직함이 있고, 그 직함이 아는 것과 모르는 것을 정합니다. PM 은 마감을 알지만 스키마는 모릅니다. 엔지니어는 규칙을 정확히 알지만 묻지 않은 것을 먼저 말해 주지 않습니다. QA 는 재현 사례를 숫자로 가지고 있습니다.

좋은 질문이 좋은 정보를 얻습니다. 그리고 동료는 사람처럼 반응합니다. 처음 보는 사람이 반말로 말을 걸면 어색해하고, 무례가 반복되면 짧아지고, 모욕하면 대화를 접습니다.

<br>

## 설계자를 위한 도구

시나리오는 편집기에서 만듭니다. 오른쪽의 설계자 AI 에게 상황을 한 줄 적으면 제목, 도입부, 인물과 그들이 아는 것, 초기 데이터, 숨은 정답, 채점 기준까지 설계해 **왼쪽 편집기에 실시간으로** 채웁니다. "QA 를 하나 더", "데이터를 40행으로" 같은 대화로 이어서 다듬습니다. 저장은 사람이 합니다.

<p align="center"><img src="docs/screenshots/studio.png" width="880" alt="시나리오 스튜디오"></p>

응시가 끝나면 대화, 워크스페이스, 실행, 에이전트 사용, 자료 조회, 화면 이탈이 하나의 타임라인으로 남고, 자동 체크와 루브릭 평가가 함께 놓입니다.

<br>

## 신뢰할 수 있는 환경

응시자의 명령은 실행할 때마다 **자기만의 공간**에서 돕니다. 다른 응시자의 작업은 보이지 않고, 인터넷에 직접 닿을 수 없으며, 시험이 끝나면 흔적 없이 사라집니다. 참고 자료는 서버가 대신 가져오고, 그 사실은 기록됩니다.

<br>

## 시작하기

```bash
git clone https://github.com/CocoRoF/odysseus.git
cd odysseus
docker compose up -d --build
```

`http://localhost:3100` 에서 시작합니다. 첫 기동에 관리자 계정이 만들어지고, 비밀번호는 로그에 한 번만 출력됩니다.

```bash
docker compose logs api | grep bootstrap
```

여섯 개의 시나리오와 세 개의 시험이 준비되어 있습니다.

만들고 운영하는 사람을 위한 내용은 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 에 있습니다.

<br>

<p align="center"><sub>MIT License</sub></p>

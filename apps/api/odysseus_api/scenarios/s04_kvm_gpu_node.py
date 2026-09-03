"""S04 — KVM GPU 패스스루 추론 VM이 느리고 가끔 부팅에 실패한다 (가상화 · 고난도)."""

DOMAIN_XML = """<domain type='kvm'>
  <name>inference-node-01</name>
  <memory unit='GiB'>96</memory>
  <currentMemory unit='GiB'>96</currentMemory>
  <vcpu placement='static'>16</vcpu>
  <os>
    <type arch='x86_64' machine='q35'>hvm</type>
    <boot dev='hd'/>
  </os>
  <features>
    <acpi/>
    <apic/>
  </features>
  <cpu mode='custom' match='exact' check='partial'>
    <model fallback='allow'>Haswell-noTSX-IBRS</model>
  </cpu>
  <clock offset='utc'/>
  <devices>
    <emulator>/usr/bin/qemu-system-x86_64</emulator>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2' cache='writeback'/>
      <source file='/var/lib/libvirt/images/inference-node-01.qcow2'/>
      <target dev='vda' bus='virtio'/>
    </disk>
    <interface type='bridge'>
      <source bridge='br0'/>
      <model type='virtio'/>
    </interface>
    <hostdev mode='subsystem' type='pci' managed='yes'>
      <source>
        <address domain='0x0000' bus='0xaf' slot='0x00' function='0x0'/>
      </source>
    </hostdev>
    <console type='pty'/>
  </devices>
</domain>
"""

LSPCI = """$ lspci -nnk | grep -A3 -i nvidia
af:00.0 3D controller [0302]: NVIDIA Corporation GA102GL [A10] [10de:2236] (rev a1)
        Subsystem: NVIDIA Corporation Device [10de:1482]
        Kernel driver in use: vfio-pci
        Kernel modules: nvidiafb, nouveau
af:00.1 Audio device [0403]: NVIDIA Corporation Device [10de:1aef] (rev a1)
        Subsystem: NVIDIA Corporation Device [10de:1482]
        Kernel driver in use: snd_hda_intel
        Kernel modules: snd_hda_intel

$ for d in /sys/kernel/iommu_groups/*/devices/*; do echo "$(basename $(dirname $(dirname $d))) $(basename $d)"; done | grep af:00
42 0000:af:00.0
42 0000:af:00.1
"""

NUMACTL = """$ numactl --hardware
available: 2 nodes (0-1)
node 0 cpus: 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15
node 0 size: 128847 MB
node 0 free: 96231 MB
node 1 cpus: 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31
node 1 size: 128847 MB
node 1 free: 118442 MB
node distances:
node   0   1
  0:  10  32
  1:  32  10

$ cat /sys/bus/pci/devices/0000:af:00.0/numa_node
1
"""

HUGEPAGES = """$ cat /proc/meminfo | grep -i huge
AnonHugePages:         0 kB
HugePages_Total:      96
HugePages_Free:       96
HugePages_Rsvd:        0
Hugepagesize:    1048576 kB

$ cat /proc/cmdline
BOOT_IMAGE=/vmlinuz-6.8.0-45-generic root=/dev/mapper/vg0-root ro intel_iommu=on iommu=pt \\
  default_hugepagesz=1G hugepagesz=1G hugepages=96
"""

LIBVIRT_LOG = """2026-08-30 03:11:52.418+0000: 1841: error : qemuProcessReportLogError:2126 :
  internal error: qemu unexpectedly closed the monitor:
  vfio 0000:af:00.0: group 42 is not viable
  Please ensure all devices within the iommu_group are bound to their vfio bus driver.

2026-08-31 02:40:07.912+0000: 1841: warning : qemuDomainObjTaint:6210 :
  Domain id=3 name='inference-node-01' uuid=... is tainted: high-privileges

2026-09-01 01:22:31.004+0000: 1841: error : virProcessRunInFork:1189 :
  internal error: child reported: unable to set memory policy: Cannot allocate memory
"""

BENCH = """# inference-node-01 성능 비교 (2026-09-01)

동일 모델(Qwen2.5-7B, bf16), 동일 요청 세트 200건.

| 환경 | 평균 TTFT | 평균 처리량 | 비고 |
|---|---|---|---|
| 베어메탈 (동일 노드) | 180 ms | 1,420 tok/s | 기준 |
| VM (inference-node-01) | 470 ms | 590 tok/s | **기준 대비 41%** |

perf 로 본 VM 게스트: `numa_foreign` / `numa_miss` 카운터가 매우 높음.
qemu 프로세스는 CPU 0-15 에서 주로 스케줄되고 있었음.
"""

RUNBOOK = """# 가상화 노드 운영 메모

- 도메인 정의: `vm/inference-node.xml` (virsh define / virsh start)
- 호스트는 IOMMU 활성화(intel_iommu=on iommu=pt) + 1GiB 휴지페이지 96장 예약 상태.
- GPU 패스스루는 vfio-pci 로 바인딩해 사용한다.
"""

SCENARIO = {
    "title": "GPU 패스스루 추론 VM이 느리고 가끔 부팅에 실패한다",
    "summary": "KVM/libvirt GPU 패스스루 — IOMMU 그룹·NUMA 로컬리티·휴지페이지·CPU 모델이 얽힌 고난도 가상화 문제",
    "difficulty": "hard",
    "briefing_md": (
        """**금요일 오전 11시.**

당신은 인프라 엔지니어링팀에서 가상화를 담당합니다. 팀은 값비싼 GPU 노드를 여러 팀이 나눠 쓰기 위해 가상 머신으로 쪼개는 실험을 해왔고, 첫 번째 추론용 VM이 지난주에 만들어졌습니다.

벤치마크 결과가 나왔습니다. 같은 하드웨어인데 VM은 베어메탈의 절반도 못 냅니다. 게다가 가끔은 부팅조차 되지 않습니다.

다음 주 월요일부터 이 VM으로 실서비스를 받기로 되어 있습니다. 담당자가 당신을 찾아왔습니다."""
    ),
    "agent_enabled": True,
    "characters": [
        {
            "key": "virt_minseok",
            "name": "최민석",
            "role": "가상화 담당",
            "color": "#10b981",
            "persona": (
                "실용적이다. 자기가 만든 XML 이라 방어적이지 않고 오히려 빨리 고치고 싶어 한다. "
                "하드웨어 토폴로지는 김도연, 성능 측정은 박지훈에게 물어보라고 안내한다." " 말을 함부로 하면 그 자리에서 지적한다. 사과하면 아무 일 없었다는 듯 다시 도와준다."
            ),
            "knowledge": (
                "추론용 VM(inference-node-01)을 KVM/libvirt 로 만들어 GPU 를 패스스루했다. 정의 파일은 vm/inference-node.xml 이다. "
                "두 가지 문제가 있다. (1) 성능이 베어메탈 대비 41% 수준이다(bench/results.md). "
                "(2) 가끔 VM 이 아예 부팅되지 않고 libvirt 로그에 vfio 오류가 남는다(logs/libvirt.log). "
                "호스트 정보는 infra/ 아래에 lspci, numactl, hugepages 출력으로 넣어뒀다. "
                "고쳐야 할 것은 vm/inference-node.xml 이고, 분석은 output/tuning-report.md 에 남겨달라. "
                "다음 주 월요일에 이 VM 로 실서비스를 받아야 한다. "
                "IOMMU/토폴로지 쪽은 김도연(인프라)이, 성능 원인 분석은 박지훈(ML)이 잘 안다."
            ),
        },
        {
            "key": "infra_doyeon",
            "name": "김도연",
            "role": "인프라 엔지니어",
            "color": "#f59e0b",
            "persona": "로그와 출력을 근거로 조목조목 설명한다. XML 을 대신 써주지는 않는다." " 예의 없는 요청에는 선을 긋는다. '요청은 정식으로 올려주세요'라고 말하고 더 도와주지 않는다.",
            "knowledge": (
                "부팅 실패 원인은 IOMMU 그룹이다. 로그의 'group 42 is not viable' 은 같은 IOMMU 그룹에 있는 장치 중 일부만 "
                "패스스루했다는 뜻이다. lspci 를 보면 GPU 는 af:00.0(3D controller)과 af:00.1(Audio device) 두 함수로 이루어져 있고 "
                "둘 다 IOMMU 그룹 42 에 있다. 따라서 도메인 XML 에 hostdev 를 **두 개** 넣어 두 함수를 모두 패스스루해야 한다. "
                "호스트는 1GiB 휴지페이지 96장을 예약해 뒀다(/proc/cmdline 의 hugepagesz=1G hugepages=96). "
                "게스트가 이걸 쓰려면 도메인에 memoryBacking > hugepages 를 명시해야 한다. 안 그러면 예약된 휴지페이지는 놀고, "
                "게스트 메모리는 일반 4K 페이지로 잡혀 TLB 미스가 늘어난다. "
                "libvirt 로그의 'unable to set memory policy: Cannot allocate memory' 도 메모리 정책을 노드에 맞추지 않아서 생긴다. "
                "노드 토폴로지는 numactl 출력에 있다 — 어느 노드에 붙여야 하는지는 GPU 의 numa_node 값을 봐라."
            ),
        },
        {
            "key": "ml_jihoon",
            "name": "박지훈",
            "role": "ML 플랫폼 엔지니어",
            "color": "#0ea5e9",
            "persona": "수치와 계측 결과로 말한다. 원인은 짚어주되 설정 문법은 김도연 소관이라고 넘긴다." " 무례한 태도에는 응답이 짧아진다. 수치만 던지고 해석은 해주지 않는다.",
            "knowledge": (
                "성능 저하의 주범은 크로스 NUMA 다. perf 로 보면 게스트에서 numa_miss/numa_foreign 카운터가 매우 높고, "
                "qemu 프로세스는 주로 CPU 0-15(노드 0)에서 돌고 있었다. 그런데 GPU(0000:af:00.0)의 numa_node 는 1 이다. "
                "즉 GPU 는 노드 1 에 붙어 있는데 vCPU 와 게스트 메모리는 노드 0 에서 잡혀 PCIe 트래픽이 인터커넥트를 건너간다. "
                "vCPU 를 노드 1 의 물리 CPU(16-31)에 고정하고, 게스트 메모리도 노드 1 에서만 잡히게 해야 한다. "
                "또 CPU 모델이 'Haswell-noTSX-IBRS' 로 고정돼 있어 최신 EPYC 의 AVX2/AVX-512 계열 명령이 게스트에 노출되지 않는다. "
                "토크나이저/전처리가 벡터 명령을 못 써서 TTFT 가 커진다 — host-passthrough 로 바꿔야 한다. "
                "이 세 가지(NUMA 고정, 휴지페이지, CPU 모델)를 고치면 베어메탈의 90% 수준까지 올라간다."
            ),
        },
    ],
    "opening_messages": [
        {
            "character_key": "virt_minseok",
            "content": (
                "GPU 패스스루로 만든 추론 VM 좀 봐주실 수 있을까요?\n"
                "성능이 베어메탈의 41% 밖에 안 나오고, 가끔은 아예 부팅이 안 됩니다 (libvirt에 vfio 에러).\n"
                "vm/inference-node.xml 이 정의 파일이고 호스트 정보는 infra/ 아래에 덤프해뒀어요.\n"
                "다음 주 월요일에 실서비스 받아야 해서 급합니다. IOMMU 쪽은 김도연님, 성능은 박지훈님이 잘 아세요."
            ),
        }
    ],
    "initial_files": [
        {"path": "vm/inference-node.xml", "content": DOMAIN_XML},
        {"path": "infra/lspci.txt", "content": LSPCI},
        {"path": "infra/numactl.txt", "content": NUMACTL},
        {"path": "infra/hugepages.txt", "content": HUGEPAGES},
        {"path": "logs/libvirt.log", "content": LIBVIRT_LOG},
        {"path": "bench/results.md", "content": BENCH},
        {"path": "RUNBOOK.md", "content": RUNBOOK},
    ],
    "objectives_md": """## 실제 요구사항

`vm/inference-node.xml` 을 고쳐야 한다. 원인은 4가지다.

### 1) 부팅 실패 — IOMMU 그룹 불완전 패스스루
`vfio 0000:af:00.0: group 42 is not viable`. lspci 상 GPU 는 **af:00.0(3D) + af:00.1(Audio)** 두 함수이고
둘 다 IOMMU 그룹 42 다. `<hostdev>` 를 **두 개** 넣어 두 함수를 모두 패스스루해야 한다.

### 2) 크로스 NUMA — 성능 41%의 주범
GPU(af:00.0)의 `numa_node` = **1**, 노드 1 의 CPU 는 **16-31**.
- `<vcpu placement='static' cpuset='16-31'>` (또는 cputune/vcpupin 으로 16-31 에 고정)
- `<numatune><memory mode='strict' nodeset='1'/></numatune>`

### 3) 휴지페이지 미사용
호스트에 1GiB 휴지페이지 96장이 예약돼 있는데 도메인이 쓰지 않는다.
`<memoryBacking><hugepages><page size='1' unit='G' nodeset='0'/></hugepages></memoryBacking>`
(page size 1G 지정. nodeset 은 선택)

### 4) CPU 모델 제약
`Haswell-noTSX-IBRS` 커스텀 모델 → 최신 벡터 명령 미노출. `<cpu mode='host-passthrough'/>` 로 변경.

### 5) 산출물
`output/tuning-report.md` 에 원인/조치/기대 효과. NUMA 와 IOMMU 그룹이 언급되어야 한다.

### 정보 분포
- 최민석(가상화): 증상 2가지, 파일 위치, 산출물 경로, 마감.
- 김도연(인프라): IOMMU 그룹 42 = af:00.0 + af:00.1, 휴지페이지 1G 96장 예약, memoryBacking 필요, 메모리 정책 오류.
- 박지훈(ML): GPU numa_node=1, 노드1 CPU 16-31, vCPU/메모리 노드1 고정, CPU 모델 host-passthrough.
""",
    "checks": [
        {
            "label": "IOMMU 그룹 전체 패스스루 (af:00.0 + af:00.1)",
            "type": "command",
            "command": (
                "python3 -c \"import xml.etree.ElementTree as T;r=T.parse('vm/inference-node.xml').getroot();"
                "f=set((a.get('bus'),a.get('function')) for h in r.iter('hostdev') for a in h.iter('address') "
                "if a.get('domain'));assert ('0xaf','0x0') in f and ('0xaf','0x1') in f;print('OK')\""
            ),
            "expected_stdout": "OK",
            "points": 18,
        },
        {
            "label": "CPU host-passthrough + 휴지페이지 + NUMA 메모리 고정",
            "type": "command",
            "command": (
                "python3 -c \"import xml.etree.ElementTree as T;r=T.parse('vm/inference-node.xml').getroot();"
                "assert r.find('cpu').get('mode')=='host-passthrough';"
                "assert r.find('memoryBacking/hugepages') is not None;"
                "assert r.find('numatune/memory').get('nodeset')=='1';print('OK')\""
            ),
            "expected_stdout": "OK",
            "points": 18,
        },
        {
            "label": "vCPU를 GPU와 같은 NUMA 노드(16-31)에 고정",
            "type": "file_contains",
            "path": "vm/inference-node.xml",
            "pattern": r"(cpuset=['\"]16-31|vcpupin[^>]*cpuset=['\"](1[6-9]|2[0-9]|3[01]))",
            "points": 16,
        },
        {
            "label": "1GiB 휴지페이지 지정",
            "type": "file_contains",
            "path": "vm/inference-node.xml",
            "pattern": r"<page[^>]*size=['\"]1['\"][^>]*unit=['\"]G['\"]",
            "points": 10,
        },
        {"label": "튜닝 리포트 작성", "type": "file_exists", "path": "output/tuning-report.md", "points": 8},
        {
            "label": "리포트에 NUMA 원인 기재",
            "type": "file_contains",
            "path": "output/tuning-report.md",
            "pattern": r"(NUMA|누마)",
            "points": 10,
        },
        {
            "label": "리포트에 IOMMU 그룹 원인 기재",
            "type": "file_contains",
            "path": "output/tuning-report.md",
            "pattern": r"(IOMMU|iommu)",
            "points": 10,
        },
    ],
}

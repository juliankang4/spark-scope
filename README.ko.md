<h1 align="center">Spark Scope</h1>

<p align="center">NVIDIA DGX Spark 계열 장비와 그 위에서 돌아가는 vLLM, SGLang 또는 TensorFold 서버를 지켜보는<br>읽기 전용 대시보드와 랙 패널입니다.</p>

<p align="center">
  <a href="https://github.com/juliankang4/spark-scope/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/juliankang4/spark-scope"></a>
  <a href="https://github.com/juliankang4/spark-scope/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/juliankang4/spark-scope/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/github/license/juliankang4/spark-scope"></a>
  <img alt="Node.js 22.13 or later" src="https://img.shields.io/badge/node-%E2%89%A5%2022.13-339933?logo=nodedotjs&amp;logoColor=white">
  <img alt="Engines: vLLM, SGLang and TensorFold" src="https://img.shields.io/badge/engines-vLLM%20%7C%20SGLang%20%7C%20TensorFold-76b900">
  <img alt="Runs on arm64 and x64" src="https://img.shields.io/badge/arch-arm64%20%7C%20x64-blue">
</p>

<p align="center"><a href="README.md">English</a> · <b>한국어</b></p>

<p align="center"><sub><code>docs/</code>의 자세한 문서는 영어판만 있습니다.</sub></p>

<p align="center"><img src="docs/screenshots/dashboard-4-nodes-ko.png" alt="노드 4대를 보여 주는 웹 대시보드"></p>

## 소개

Spark Scope는 NVIDIA DGX Spark 계열 장비(DGX Spark, ASUS Ascent GX10, MSI EdgeXpert 등 GB10 장비)와 그 위에서 실행 중인 vLLM, SGLang 또는 TensorFold 서버를 모니터링합니다. 노드 한 대부터 작은 클러스터까지 쓸 수 있습니다.

원래는 10인치 랙에 넣은 제 4노드 링(ASUS GX10 3대와 MSI EdgeXpert 1대)을 보려고 만들었습니다. 이 저장소에는 그 대시보드를 올렸습니다. 제 호스트 이름은 지웠고 노드 1대와 2대 구성에 맞게 레이아웃을 다시 짰습니다. GX10용 2U 랙 모듈은 [MakerWorld](https://makerworld.com/en/models/3380382)에 있습니다.

npm 의존성 없이 Node.js 프로세스 하나로 동작합니다. 각 노드에서 로컬이나 SSH로 데이터를 수집하고 추론 서버의 Prometheus 메트릭을 읽고 토큰 사용량을 SQLite에 기록합니다. 페이지는 두 개입니다. 하나는 `/`의 웹 대시보드(위 화면)이고 다른 하나는 바 디스플레이나 Raspberry Pi 키오스크에 띄우는 `/rack/`의 1920 x 480 랙 패널입니다.

![노드 4대를 보여 주는 랙 패널](docs/screenshots/rack-4-nodes-ko.png)

- **읽기 전용이며 노드에 에이전트를 두지 않습니다.** 수집할 때마다 읽기 전용 셸 스크립트를 SSH로 보내고(로컬 노드는 직접 실행하고) 그 출력을 파싱합니다. 노드와 추론 서버에서는 아무것도 시작하거나 멈추거나 바꾸지 않습니다.
- **모르는 값은 모른다고 표시합니다.** 관측하지 못한 값은 0이 아니라 `unknown`(한국어 화면에서는 '알 수 없음')으로 나옵니다.
- **외부 호스트에 기대지 않습니다.** 페이지는 데스크톱, 휴대폰, 랙 디스플레이 어디서든 다른 곳의 리소스를 하나도 불러오지 않고 작동합니다.

### 보여 주는 정보

- **노드**: GPU 사용률, 온도, 전력, 클럭, 남은 메모리를 보여 줍니다. 세부 정보에는 디스크, CPU, NVMe·NIC 온도, thermal zone, 추론 컨테이너, 커널 오류가 나옵니다.
- **노드 간 연결**: QSFP 케이블마다 두 논리 경로와 트래픽, 상태를 보여 줍니다(노드 2대 이상).
- **추론**: 15분~6시간 범위의 출력 tok/s, prefill과 decode 속도, 최근 5분 TTFT·TPOT p95, 캐시 적중률, KV cache, 대기열을 보여 줍니다.
- **토큰 사용량**: 한 달 사용량을 내역, 달력, 차트로 보여 주고 모델별 표와 CSV 내보내기도 있습니다.
- **미니 창**: 모델 테스트를 지켜볼 때 쓰는 작은 창입니다. Chrome과 Edge에서는 다른 창 위에 항상 떠 있고, Safari와 휴대폰에서는 페이지가 미니 창 화면으로 바뀝니다. '측정 시작'부터 '중지'까지를 한 번의 측정으로 기록합니다.
- **랙 패널**: 노드마다 베이가 하나씩 있고 하단 띠에 클러스터 상태, 모델, 처리량이 나옵니다.

자세한 내용은 [웹 페이지](docs/dashboard.md)와 [랙 패널](docs/rack.md) 문서에 있습니다. 스크린샷은 `tools/fixtures.mjs`의 가상 데이터로 찍었습니다.

## 설치

### 요구 사항

- Node.js 22.13 이상이 필요합니다(24 LTS 권장). 토큰 사용량 기록에 내장 `node:sqlite`를 쓰기 때문에, 이보다 오래된 Node에서는 서버가 이유를 알리는 메시지를 띄우고 멈춥니다. Ubuntu 24.04(DGX OS)와 Raspberry Pi OS의 `nodejs` 패키지는 버전이 너무 낮습니다. NodeSource에 두 OS용 arm64·x86 패키지가 모두 있습니다.

  ```bash
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ```

  nvm 같은 버전 관리자를 써도 됩니다. 일부 Node 버전은 시작할 때 "SQLite is an experimental feature" 경고를 띄우는데, 동작에는 문제가 없습니다.
- 모니터링할 각 노드에는 `bash`, `nvidia-smi`, 기본 coreutils가 있는 Linux가 필요합니다. DGX OS에는 이미 다 들어 있습니다. `systemd`, `journalctl`, `docker`는 있으면 씁니다.
- 원격 노드를 보려면 대시보드를 돌리는 머신에 SSH 클라이언트가 있어야 하고 각 노드에 key 기반 SSH로 접속할 수 있어야 합니다.
- 추론 서버는 선택 사항입니다. Prometheus 메트릭을 내보내는 vLLM(메트릭이 기본으로 켜져 있음), SGLang(`--enable-metrics`로 시작), TensorFold(메트릭이 항상 켜져 있음) 중 하나면 됩니다.

### Spark 없이 체험하기

```bash
git clone https://github.com/juliankang4/spark-scope.git
cd spark-scope
npm run demo
```

이렇게 실행하면 <http://127.0.0.1:8787/>에서 대시보드가, `/rack/`에서 랙 패널이, `/mini/`에서 미니 창이 열립니다. 모두 가상 데이터로 돌아갑니다. `npm run demo -- --nodes 2 --mode fault`는 노드 2대로 장애 상황을 보여 줍니다(모드: `serving`, `fault`, `idle`). `--servers 2`를 붙이면 노드를 모델 서버 2개로 나누고 `--off`를 더하면 마지막 서버를 끕니다. 다른 포트를 쓰려면 `--port`를 붙입니다. 아무것도 수집하거나 기록하지 않고, 다른 머신에 접속하지도 않습니다.

### 노드 1대: Spark에서 바로 실행

저장소에 들어 있는 `topology.json`은 로컬에서 수집하는 노드 1대(`"host": "local"`)를 정의하므로 SSH를 쓰지 않습니다.

```bash
git clone https://github.com/juliankang4/spark-scope.git
cd spark-scope
node --version          # 22.13 이상
SPARK_SCOPE_API_URL=http://127.0.0.1:8000 npm start
```

Spark에서 <http://127.0.0.1:8787/> 주소를 엽니다. 네트워크에 노출하지 않고 노트북에서 보려면, SSH로 포트를 포워딩한 뒤 노트북에서 같은 주소를 열면 됩니다.

```bash
ssh -L 8787:127.0.0.1:8787 you@your-spark
```

SGLang 기본 포트를 쓴다면 `SPARK_SCOPE_API_URL=http://127.0.0.1:30000`, TensorFold라면 `http://127.0.0.1:8080`으로 지정합니다. 추론 서버가 없어도 노드 카드는 그대로 작동하고 추론 패널에는 `unknown`이나 `stopped`가 표시됩니다.

## 환경에 맞게 적용하기

### SSH로 여러 노드 연결

대시보드는 Spark 중 한 대에서 돌려도 되고(그 노드는 `"host": "local"`, 나머지는 SSH), 노드에 접속할 수 있는 다른 Linux나 macOS 머신에서 돌려도 됩니다(모든 노드를 SSH로 연결). 노드에는 아무것도 설치하지 않습니다. 수집할 때마다 읽기 전용 셸 스크립트를 SSH로 `bash -s`에 보내고 그 출력을 파싱합니다.

1. 대시보드 머신에서 **전용 key를 만듭니다.**

   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_spark_scope -N "" -C spark-scope
   ```

2. **각 노드에서 key를 허용합니다.** 대시보드가 접속할 계정의 `~/.ssh/authorized_keys`에 포워딩과 터미널을 막은 한 줄을 추가합니다.

   ```text
   no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA...your-public-key... spark-scope
   ```

   이 옵션은 key가 터널, 에이전트 포워딩, 대화형 터미널에 쓰이지 않게 막습니다. 하지만 실행할 수 있는 명령까지 제한하지는 않습니다. 수집기에 셸이 필요하므로, 이 key로는 그 계정이 할 수 있는 일을 모두 할 수 있습니다. 그만한 권한을 줘도 괜찮은 계정을 써야 합니다. (`command="bash -s"`를 강제해도 보호가 늘지 않습니다. 스크립트가 stdin으로 들어오기 때문입니다.)

3. 대시보드 머신의 `~/.ssh/config`에 **노드마다 SSH 별칭을 추가합니다.** `topology.json`의 `host`에는 이 별칭을 씁니다.

   ```text
   Host spark-2
       HostName spark-2.lan              # 이름 해석이 되는 호스트 이름 또는 IP 주소
       User your-user
       IdentityFile ~/.ssh/id_ed25519_spark_scope
       IdentitiesOnly yes
       # 선택: 이 호스트 key를 평소 쓰는 known_hosts와 따로 보관합니다. 4단계에서 처음
       # 접속하기 전에 넣어야 그때 승인한 key가 이 파일에 저장됩니다.
       UserKnownHostsFile ~/.ssh/known_hosts_spark_scope
       # 선택: 5초마다 하는 수집에 연결 하나를 재사용합니다.
       ControlMaster auto
       ControlPath ~/.ssh/spark-scope-%C
       ControlPersist 10m
   ```

4. **호스트 key를 확인한 뒤 한 번씩 승인합니다.** 수집기는 SSH를 `BatchMode=yes`로 실행하므로, 모르는 호스트 key나 바뀐 호스트 key를 만나면 묻지 않고 수집이 실패합니다. 직접 한 번 접속해서, 그때 나오는 fingerprint를 노드에서 확인한 값과 비교합니다. 노드에서는 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`로 확인합니다.

   ```bash
   ssh spark-2 true
   ssh -o BatchMode=yes spark-2 'nvidia-smi -L'   # 아무것도 묻지 않고 실행돼야 합니다
   ```

   모든 노드를 승인했다면 `Host` 블록에 `StrictHostKeyChecking yes`를 추가해도 됩니다. 그러면 호스트 key가 바뀌었을 때 승인을 묻지 않고 거부합니다.

5. **클러스터 구성을 적습니다.** 예제를 설정 디렉터리에 복사해서 고치면 됩니다. 거기에 두면 `git pull`을 해도 고친 내용과 충돌하지 않습니다.

   ```bash
   mkdir -p ~/.config/spark-scope
   cp examples/topology.2-node.json ~/.config/spark-scope/topology.json
   npm start
   ```

   `examples/`에는 노드 1대, 노드 2대(케이블 2개), 노드 3대·4대 링 구성 예제가 있습니다. 노드마다 `id`와 `host`(SSH 별칭 또는 `"local"`)가 있고 `name`, `role`, `hardware`는 선택입니다. 링크에는 양쪽 끝마다 두 논리 경로(plane)의 네트워크 인터페이스를 적습니다. 필드, 인터페이스 이름, 링크 상태는 [토폴로지](docs/topology.md) 문서에서 설명합니다.

노드 쪽 권한 중 두 가지는 선택 사항입니다. 커널 오류 요약을 보려면 커널 저널(`journalctl -k`)을 읽을 수 있어야 합니다. root가 아닌 계정은 `systemd-journal`이나 `adm` 그룹에 넣으면 됩니다. 이 권한이 없으면 패널에 "커널 진단 정보 없음"이 표시됩니다. 컨테이너 세부 정보를 보려면 Docker 소켓에 접근할 수 있어야 합니다. 그런데 `docker` 그룹 멤버십은 root 권한과 같으므로, 이 대시보드만 보려고 그 권한을 주어서는 안 됩니다. 권한이 없으면 컨테이너 세부 정보가 나오지 않습니다.

### vLLM, SGLang 또는 TensorFold

`SPARK_SCOPE_API_URL`에 추론 서버 주소를 지정합니다. 여러 노드로 서빙한다면 API가 떠 있는 노드를 가리켜야 합니다. vLLM과 TensorFold는 메트릭이 기본으로 켜져 있습니다. SGLang은 `--enable-metrics`를 붙여 시작해야 합니다. SGLang과 TensorFold는 일부 수치의 측정 방식이 다릅니다. 그 차이는 [추론 엔진](docs/configuration.md#inference-engines) 항목에 정리했습니다. 다른 엔진도 노드 카드에서는 인식하지만 메트릭은 읽지 않습니다.

노드를 그룹으로 나눠 따로 서빙한다면(케이블로 연결한 노드 2대가 각자 자기 모델을 돌리거나, 4대를 2 + 2로, 3대를 2 + 1로 나눈 경우) `SPARK_SCOPE_API_URL` 대신 `topology.json`에 그룹마다 모델 서버를 적고 API와 노드를 지정합니다.

```json
"servers": [
  { "id": "a", "api": "http://spark-1:8000", "nodes": ["1", "2"] },
  { "id": "b", "api": "http://spark-3:30000", "nodes": ["3", "4"] }
]
```

그러면 대시보드 하나에서 모든 서버를 봅니다. 차트 위에 서버별 행이 생기고 서버마다 선과 엔진 패널이 하나씩 붙습니다(설정에서 한 번에 하나씩만 볼 수도 있습니다). 랙 패널 하단 띠에는 칩이 표시되고 토큰 원장은 모든 서버가 하나를 함께 씁니다. 필드와 규칙은 [모델 서버](docs/topology.md#model-servers) 항목에 정리했습니다.

### 서비스로 실행

`systemd/spark-scope.service.example`은 placeholder가 들어 있는 systemd user unit입니다. 이 파일을 `~/.config/systemd/user/spark-scope.service`로 복사하고 `WorkingDirectory`, `ExecStart`(`command -v node`로 나오는 경로), `Environment=` 줄을 고친 다음 아래 명령을 실행합니다.

```bash
systemctl --user daemon-reload
systemctl --user enable --now spark-scope
journalctl --user -u spark-scope -f
sudo loginctl enable-linger "$USER"   # 로그인 세션 없이도 계속 실행
```

나중에 업데이트할 때는 `git pull --ff-only`를 실행하고 서비스를 다시 시작하면 됩니다. `~/.config/spark-scope/`의 토폴로지와 `~/.local/share/spark-scope/`의 토큰 사용량 기록은 그대로 남습니다. 릴리스에서 따로 바꿔야 할 내용이 있으면 [CHANGELOG.md](CHANGELOG.md)에 적어 둡니다.

### 랙 패널 키오스크

바 디스플레이를 단 Raspberry Pi로 부팅하자마자 `/rack/`을 전체 화면으로 띄울 수 있습니다. `kiosk/`에 스크립트, autostart 항목, 포인터를 숨기는 labwc 규칙이 있습니다. Pi에서 대시보드를 직접 돌려도 되고 다른 곳에서 돌아가는 대시보드를 띄우기만 해도 됩니다. 설치 순서, 디스플레이 크기, 주소 옵션은 [랙 패널](docs/rack.md#raspberry-pi-kiosk) 문서를 보면 됩니다.

## 설정

<p align="center"><img src="docs/screenshots/settings-ko.png" alt="설정 창의 노드 카드 항목" width="820"></p>

톱니바퀴 버튼을 누르면 설정이 열립니다.

- **노드 카드**: 측정값 네 개와 그 순서, 사용량 막대, 레이블 길이(길게 또는 짧게), 주황색 표시 기준을 정합니다.
- **색상**: 노드마다 색을 팔레트에서 고르거나 직접 선택합니다.
- **단위**: °C 또는 °F, GiB 또는 GB, 24시간제 또는 12시간제를 고릅니다.
- **대시보드**: 언어(English 또는 한국어), 표시할 패널, 차트 기간, 새로 고침 간격, 디자인(기본, 콘솔, 소프트), 테마를 정합니다.
- **랙 패널**: 하단 띠 움직임을 정하고 현재 설정이 담긴 키오스크 URL을 볼 수 있습니다.

설정은 브라우저마다 따로 저장됩니다. "설정 링크 복사"를 쓰면 다른 브라우저로 옮길 수 있습니다. 자세한 내용은 [웹 페이지](docs/dashboard.md#settings) 문서에 있습니다.

서버 자체는 환경 변수로 설정합니다. 보통 필요한 변수는 아래 표에 있습니다.

| 변수 | 기본값 | 용도 |
|---|---|---|
| `SPARK_SCOPE_API_URL` | `http://127.0.0.1:8000` | 추론 서버입니다. vLLM은 8000, SGLang은 30000, TensorFold는 8080 포트를 씁니다. |
| `SPARK_SCOPE_HOST` | `127.0.0.1` | listen 주소입니다. `0.0.0.0`으로 두면 다른 머신에서도 접속할 수 있습니다. [보안](#보안)을 함께 봐야 합니다. |
| `SPARK_SCOPE_PORT` | `8787` | listen 포트입니다. |
| `SPARK_SCOPE_TOPOLOGY` | `~/.config/spark-scope/topology.json` | 토폴로지 파일입니다. 이 파일이 없으면 저장소에 들어 있는 노드 1대용 `topology.json`을 씁니다. |

토큰 사용량 기록의 시간대와 수집 간격을 포함한 전체 목록은 [구성](docs/configuration.md) 문서에, JSON 엔드포인트는 [HTTP API](docs/api.md) 문서에 있습니다.

## 보안

- **인증도 TLS도 없습니다.** 포트에 접근할 수 있으면 누구나 노드 이름, SSH 별칭, 모델 이름, 커널 오류 메시지, 토큰 수를 볼 수 있습니다.
- **기본값은 localhost입니다.** 서버는 `127.0.0.1`에서만 연결을 받습니다. SSH 포트 포워딩을 쓰거나, 네트워크에 있는 모든 사람을 믿을 수 있을 때만 LAN이나 Tailscale 같은 사설 오버레이 네트워크에 엽니다. 인터넷에 노출해서는 안 됩니다. 인증을 붙인 원격 접속이 필요하면 인증 기능이 있는 리버스 프록시 뒤에 둡니다.
- **자기 호스트 이름으로 온 요청만 받습니다.** `Host` 헤더에 다른 사이트 이름이 적힌 요청은 거부합니다(HTTP 403). 그래서 다른 곳의 웹 페이지가 자기 도메인을 이 머신 주소로 돌려(DNS rebinding) 방문자의 브라우저로 API를 읽어 갈 수 없습니다. localhost, IP 주소, 이 머신의 호스트 이름은 따로 설정하지 않아도 접속됩니다. 리버스 프록시 이름 같은 다른 이름은 `SPARK_SCOPE_ALLOWED_HOSTS`에 추가합니다.
- **외부 리소스를 쓰지 않습니다.** 모든 응답에 Content-Security-Policy가 붙습니다. 이 정책은 서버 자신의 스크립트, 스타일, 폰트, 요청만 허용하고 다른 페이지가 프레임으로 넣는 것도 막습니다.
- **SSH key로 명령을 실행할 수 있습니다.** 실행 권한은 그 key로 로그인하는 계정과 같습니다. 전용 key와 위의 `authorized_keys` 옵션을 쓰고 그만한 권한을 줘도 괜찮은 계정을 골라야 합니다.

취약점 제보 방법은 [SECURITY.md](SECURITY.md)에 있습니다.

## 제한 사항

- 노드마다 `nvidia-smi`가 보고하는 첫 번째 GPU만 표시합니다. GB10 시스템에는 이 방식이 맞습니다.
- TSOC/TS1P 온도와 A/B 논리 경로 구성은 DGX Spark 계열 하드웨어에만 있습니다. NVIDIA GPU가 달린 다른 Linux 머신에서도 대부분 작동하지만 이 부분은 `unknown`으로 나오거나 그에 맞는 토폴로지가 필요합니다.
- 대시보드 하나는 추론 서버 하나만 봅니다.
- 차트 데이터는 메모리에 6시간 동안 보관하며 서버가 다시 시작되거나 서빙 중인 모델이 바뀌면 초기화됩니다. 토큰 사용량 기록은 디스크에 남고 카운터 증가분을 더해 집계합니다. 재시작을 어떻게 처리하는지는 [토큰 사용량](docs/dashboard.md#token-ledger) 문서에 적었습니다.

## 기여

pull request를 열기 전에 읽어야 할 내용은 [CONTRIBUTING.md](CONTRIBUTING.md)에, 테스트와 렌더링 검사는 [개발](docs/development.md) 문서에, 릴리스별 변경 사항은 [CHANGELOG.md](CHANGELOG.md)에 있습니다.

## 라이선스

MIT 라이선스입니다. 전문은 [LICENSE](LICENSE)에 있습니다. `public/fonts/`의 폰트(Archivo, Bebas Neue)는 자체 라이선스인 SIL Open Font License 1.1을 따르며 라이선스 전문이 같은 폴더에 있습니다.

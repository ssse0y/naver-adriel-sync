# Naver Search Ads Operations Automation

네이버 검색광고 API와 Google Apps Script로 반복적인 광고 운영 점검과 비용 적재를 자동화한 프로젝트입니다.

## 해결한 문제

여러 쇼핑검색 캠페인의 소재를 일일이 열어 확장소재 등록 상태를 확인하는 업무를 자동화했습니다. 활성 상태의 캠페인·광고그룹·소재만 선별하고, 소재 단위 확장소재를 조회해 Google Sheets에 점검 목록을 만듭니다.

또한 브랜드검색·신제품검색 계약 금액을 일별 비용으로 배분해 외부 대시보드 적재 형식으로 변환합니다.

## 핵심 기능

### 쇼핑검색 PROMOTION 확장소재 점검

실행 함수: `buildNaverPromotionCheck`

- 활성 `SHOPPING` 캠페인만 조회
- 활성 광고그룹과 활성 광고 소재만 처리
- 이름이 `h-s`로 끝나는 광고그룹 제외
- 광고 소재 ID를 `ownerId`로 사용해 소재 단위 확장소재 조회
- `SHOPPING_EXTRA`는 점검 대상에서 제외
- `PROMOTION` 소재와 대상 확장소재가 없는 소재를 구분해 출력
- 목록 응답에서 상품명이 비어 있으면 소재 상세 API로 보완 조회
- HTTP 429 발생 시 지수 백오프로 자동 재시도
- 동시 실행 방지를 위한 Apps Script Lock 적용

출력 시트: `네이버_PROMOTION확인`

| 캠페인 | 광고그룹 | 소재ID | 상품명 | 확장소재ID | 확장소재유형 | 확장소재내용 | 확장소재상태 | 확장소재검토상태 |
|---|---|---|---|---|---|---|---|---|

구현 파일: [`ShoppingPromotionAudit.gs`](./ShoppingPromotionAudit.gs)

### 고정비 광고 일별 비용 적재

실행 함수: `buildAdrielDailyBrandCosts`

- 브랜드검색과 신제품검색 계약 조회
- 결제금액에서 환불과 VAT를 제거한 뒤 계약 일수로 일별 배분
- 실행일 전일까지, 2025년 1월 1일 이후 데이터만 출력
- 동일 날짜·캠페인·광고그룹 비용 합산

출력 시트: `Adriel_연동`

구현 파일: [`광고비용 자동 적재.gs`](./광고비용%20자동%20적재.gs)

## 처리 흐름

```text
Campaigns
   ↓ 활성 SHOPPING 필터
Adgroups
   ↓ 활성 상태 + h-s 제외
Ads
   ↓ 활성 소재 필터
Ad Extensions(ownerId = nccAdId)
   ↓ SHOPPING_EXTRA 제외
PROMOTION / 확장소재 없음 분류
   ↓
Google Sheets
```

## 설정

Apps Script의 **프로젝트 설정 → 스크립트 속성**에 다음 값을 등록합니다.

| 속성 | 설명 |
|---|---|
| `NAVER_API_KEY` | 네이버 검색광고 API License |
| `NAVER_SECRET_KEY` | Secret Key |
| `NAVER_CUSTOMER_ID` | 광고계정 Customer ID |

인증정보는 코드나 저장소에 저장하지 않고 Apps Script의 스크립트 속성에서만 읽습니다.

## 실행 방법

1. Google Spreadsheet에서 **확장 프로그램 → Apps Script**를 엽니다.
2. `.gs` 파일을 프로젝트에 추가합니다.
3. 스크립트 속성에 네이버 API 인증정보를 등록합니다.
4. `buildNaverPromotionCheck` 또는 `buildAdrielDailyBrandCosts`를 실행합니다.
5. 최초 실행 시 Google Sheets 및 외부 요청 권한을 승인합니다.

## 기술적 포인트

- HMAC-SHA256 기반 네이버 검색광고 API 인증
- `UrlFetchApp.fetchAll`을 이용한 제한적 병렬 처리
- 429 응답에 대한 지수 백오프 재시도
- 서로 다른 확장소재 JSON 구조의 재귀 파싱
- API 목록 응답과 상세 응답을 결합한 결측 상품명 보완
- 재실행 시 중복이 생기지 않는 전체 갱신 방식
- API 키가 Git 기록에 포함되지 않는 설정 분리

## 보안

- 실제 API 키와 고객 ID를 코드에 입력하지 마세요.
- `.env`, `credentials.json`, `secrets.*`, `.clasp.json`, `.clasprc.json`은 Git에서 제외됩니다.
- 공개 저장소에 올리기 전 커밋 이력에도 인증정보가 없는지 확인하세요.

# Naver fixed-cost ads to Adriel

네이버 검색광고의 브랜드검색과 신제품검색 계약을 조회해 Google Sheets의 `Adriel_연동` 탭에 일별 광고비로 작성하는 Google Apps Script입니다.

## 계산 원리

1. 캠페인과 광고그룹을 조회합니다.
2. `BRAND_SEARCH` 광고그룹은 `/ncc/time-contracts`, `BRAND_NEW` 광고그룹은 `/ncc/brand-new/contracts`에서 계약을 조회합니다.
3. 실결제금액을 `paymentAmt - refundAmt`로 계산합니다.
4. VAT 별도 총광고비를 `round(실결제금액 / 1.1)`로 계산합니다.
5. 시작일과 종료일을 포함한 전체 노출일수로 균등 배분합니다.
6. 나누어떨어지지 않는 원 단위는 앞 날짜부터 1원씩 배분하여 계약 총액과 일별 합계를 일치시킵니다.
7. 미래 비용은 넣지 않고 실행일 기준 어제까지 작성합니다.
8. 동일 날짜·캠페인·광고그룹의 비용은 합산합니다.

## 출력 열

| 일자 | 캠페인 | 캠페인ID | 광고세트 | 광고세트ID | 광고비(VAT별도) | 채널 | 광고계정 |
|---|---|---|---|---|---:|---|---|

## 설정

Apps Script의 **프로젝트 설정 → 스크립트 속성**에 다음 값을 등록합니다.

| 속성 | 값 |
|---|---|
| `NAVER_API_KEY` | 네이버 검색광고 API License |
| `NAVER_SECRET_KEY` | Secret Key |
| `NAVER_CUSTOMER_ID` | 광고계정 Customer ID |

실제 키를 `Code.gs` 또는 저장소에 커밋하지 마세요.

## 실행

1. `diagnoseNaverSetup`을 실행해 세 속성이 모두 `정상`인지 확인합니다.
2. `buildAdrielDailyBrandCosts`를 실행해 최초 데이터를 생성합니다.
3. `createDailyUpdateTrigger`를 한 번 실행하면 매일 오전 6~7시(KST)에 자동 갱신됩니다.

단순 행 추가가 아니라 전체 데이터를 재계산해 덮어쓰므로 계약 취소·환불 변경과 중복을 안전하게 처리합니다.


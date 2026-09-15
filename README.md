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

### 일별 광고비 계산 기준

- `UPCOMING_EXPOSE`, `ON_EXPOSING`, `EXPOSE_COMPLETED` 계약만 반영합니다.
- 실제 노출 시작·종료일을 우선하며, 정상 계약에서 해당 값이 비어 있으면 계약 시작·종료일을 사용합니다.
- 결제금액에서 환불금액을 차감하고 VAT를 제거한 뒤 계약 일수로 나눠 일별 금액을 반올림합니다.
- `Adriel_연동`에는 2025년 1월 1일 이후 데이터만 출력합니다.
- 오늘 비용은 확정 전일 수 있으므로 전일까지 출력합니다.

## 쇼핑검색 소재 및 소재별 확장소재 조회

`buildNaverShoppingCreativeExtensions`를 실행하면 `campaignTp`이 `SHOPPING`인
캠페인만 골라 `네이버_쇼핑소재` 탭을 새로 작성합니다.

1. 캠페인에 속한 광고그룹별로 `/ncc/ads`를 조회합니다.
2. 각 광고 소재의 `nccAdId`를 `ownerId`로 사용해 `/ncc/ad-extensions`를 조회합니다.
3. `SHOPPING_EXTRA`, `DESCRIPTION_EXTRA`를 포함한 모든 소재별 확장소재를 출력합니다.
4. 문구는 `추가홍보문구/확장소재내용` 열에 펼치고, 유형별 구조 차이를 확인할 수 있도록 소재와 확장소재의 원본 JSON도 보존합니다.
5. 확장소재가 없는 광고 소재도 확장소재 열이 빈 행으로 출력됩니다.

Apps Script 편집기에서 `buildNaverShoppingCreativeExtensions`를 선택해 실행하세요.
기존 광고비 갱신 함수 및 트리거에는 영향을 주지 않습니다.

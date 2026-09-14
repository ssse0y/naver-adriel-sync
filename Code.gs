const NAVER_BASE_URL = 'https://api.searchad.naver.com';
const OUTPUT_SHEET_NAME = 'Adriel_연동';
const TIME_ZONE = 'Asia/Seoul';
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function createNaverSignature_(timestamp, method, uri, secretKey) {
  const message = `${timestamp}.${method}.${uri}`;
  const bytes = Utilities.computeHmacSha256Signature(
    message,
    secretKey,
    Utilities.Charset.UTF_8
  );
  return Utilities.base64Encode(bytes);
}

function getNaverHeaders_(method, uri) {
  const properties = PropertiesService.getScriptProperties();
  const apiKey = properties.getProperty('NAVER_API_KEY');
  const secretKey = properties.getProperty('NAVER_SECRET_KEY');
  const customerId = properties.getProperty('NAVER_CUSTOMER_ID');
  const missing = [];
  if (!apiKey) missing.push('NAVER_API_KEY');
  if (!secretKey) missing.push('NAVER_SECRET_KEY');
  if (!customerId) missing.push('NAVER_CUSTOMER_ID');
  if (missing.length) {
    throw new Error(`누락된 스크립트 속성: ${missing.join(', ')}`);
  }
  const timestamp = String(Date.now());
  return {
    'Content-Type': 'application/json; charset=UTF-8',
    'X-Timestamp': timestamp,
    'X-API-KEY': apiKey,
    'X-Customer': customerId,
    'X-Signature': createNaverSignature_(timestamp, method, uri, secretKey)
  };
}

function naverGet_(uri, params = {}) {
  const query = Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  const url = NAVER_BASE_URL + uri + (query ? `?${query}` : '');
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: getNaverHeaders_('GET', uri),
    muteHttpExceptions: true
  });
  const statusCode = response.getResponseCode();
  const body = response.getContentText();
  if (statusCode !== 200) {
    throw new Error(`네이버 API 오류 ${statusCode}\n요청: ${uri}\n응답: ${body}`);
  }
  return JSON.parse(body);
}

function formatApiDateKst_(value) {
  return Utilities.formatDate(new Date(value), TIME_ZONE, 'yyyy-MM-dd');
}

function createKstDate_(dateText) {
  return new Date(`${dateText}T00:00:00+09:00`);
}

function buildAdrielDailyBrandCosts() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('이미 동일한 업데이트가 실행 중입니다.');
  try {
    const campaigns = naverGet_('/ncc/campaigns');
    const adgroups = naverGet_('/ncc/adgroups');
    const allowedStatuses = [
      'UPCOMING_EXPOSE', 'ON_EXPOSING', 'UPCOMING_CANCEL',
      'CANCELED_ON_EXPOSING', 'EXPOSE_COMPLETED'
    ];
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const cutoffText = Utilities.formatDate(yesterday, TIME_ZONE, 'yyyy-MM-dd');
    const cutoffDate = createKstDate_(cutoffText);
    const campaignMap = {};
    campaigns.forEach(campaign => {
      campaignMap[campaign.nccCampaignId] = campaign;
    });
    const targetAdgroups = adgroups.filter(adgroup => {
      const campaign = campaignMap[adgroup.nccCampaignId];
      return campaign && (
        adgroup.adgroupType === 'BRAND_SEARCH' ||
        adgroup.adgroupType === 'BRAND_NEW' ||
        campaign.campaignTp === 'BRAND_SEARCH' ||
        campaign.campaignTp === 'BRAND_NEW'
      );
    });
    const dailyCostMap = new Map();
    targetAdgroups.forEach(adgroup => {
      const campaign = campaignMap[adgroup.nccCampaignId];
      const isBrandNew =
        adgroup.adgroupType === 'BRAND_NEW' || campaign.campaignTp === 'BRAND_NEW';
      const contractUri = isBrandNew
        ? '/ncc/brand-new/contracts'
        : '/ncc/time-contracts';
      const contracts = naverGet_(contractUri, { adgroupId: adgroup.nccAdgroupId });
      contracts.forEach(contract => {
        if (!allowedStatuses.includes(contract.contractStatus)) return;
        const startValue = contract.exposureStartDt || contract.contractStartDt;
        const endValue = contract.exposureEndDt || contract.contractEndDt;
        if (!startValue || !endValue) return;
        const startDate = createKstDate_(formatApiDateKst_(startValue));
        const endDate = createKstDate_(formatApiDateKst_(endValue));
        const contractDays = Math.floor(
          (endDate.getTime() - startDate.getTime()) / MILLISECONDS_PER_DAY
        ) + 1;
        if (contractDays <= 0 || startDate > cutoffDate) return;
        const outputEndDate = endDate > cutoffDate ? cutoffDate : endDate;
        const outputDays = Math.floor(
          (outputEndDate.getTime() - startDate.getTime()) / MILLISECONDS_PER_DAY
        ) + 1;
        const netPaymentInclVat = Math.max(
          0,
          Number(contract.paymentAmt || 0) - Number(contract.refundAmt || 0)
        );
        const totalCostExVat = Math.round(netPaymentInclVat / 1.1);
        if (totalCostExVat <= 0) return;
        const basicDailyCost = Math.floor(totalCostExVat / contractDays);
        const remainder = totalCostExVat - basicDailyCost * contractDays;
        for (let dayIndex = 0; dayIndex < outputDays; dayIndex++) {
          const currentDate = new Date(
            startDate.getTime() + dayIndex * MILLISECONDS_PER_DAY
          );
          const dateText = Utilities.formatDate(currentDate, TIME_ZONE, 'yyyy-MM-dd');
          const dailyCost = basicDailyCost + (dayIndex < remainder ? 1 : 0);
          const campaignId = campaign.nccCampaignId || '';
          const adgroupId = contract.nccAdgroupId || adgroup.nccAdgroupId || '';
          const customerId = String(
            contract.customerId || adgroup.customerId || campaign.customerId || ''
          );
          const key = [dateText, campaignId, adgroupId, customerId].join('|');
          if (dailyCostMap.has(key)) {
            dailyCostMap.get(key)[5] += dailyCost;
          } else {
            dailyCostMap.set(key, [
              dateText,
              campaign.name || '',
              campaignId,
              contract.adgroupName || adgroup.name || '',
              adgroupId,
              dailyCost,
              'naver',
              customerId
            ]);
          }
        }
      });
    });
    const output = Array.from(dailyCostMap.values()).sort((a, b) =>
      String(a[0]).localeCompare(String(b[0])) ||
      String(a[1]).localeCompare(String(b[1])) ||
      String(a[3]).localeCompare(String(b[3]))
    );
    writeAdrielSheet_(output);
    console.log(`Adriel 업데이트 완료: ${output.length}행 / 기준일: ${cutoffText}`);
  } finally {
    lock.releaseLock();
  }
}

function writeAdrielSheet_(output) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName(OUTPUT_SHEET_NAME) ||
    spreadsheet.insertSheet(OUTPUT_SHEET_NAME);
  const headers = [
    '일자', '캠페인', '캠페인ID', '광고세트', '광고세트ID',
    '광고비(VAT별도)', '채널', '광고계정'
  ];
  sheet.clearContents();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (!output.length) {
    sheet.getRange(2, 1).setValue(
      '조회 가능한 브랜드검색 또는 신제품검색 비용이 없습니다.'
    );
    return;
  }
  sheet.getRange(2, 1, output.length, headers.length).setValues(output);
  sheet.getRange(2, 3, output.length, 1).setNumberFormat('@');
  sheet.getRange(2, 5, output.length, 1).setNumberFormat('@');
  sheet.getRange(2, 6, output.length, 1).setNumberFormat('#,##0');
  sheet.getRange(2, 8, output.length, 1).setNumberFormat('@');
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, headers.length);
  SpreadsheetApp.flush();
}

function createDailyUpdateTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(trigger =>
      trigger.getHandlerFunction() === 'buildAdrielDailyBrandCosts'
    )
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger('buildAdrielDailyBrandCosts')
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .inTimezone(TIME_ZONE)
    .create();
  console.log('매일 자동 업데이트 트리거 생성 완료');
}

function diagnoseNaverSetup() {
  const properties = PropertiesService.getScriptProperties();
  const result = {
    NAVER_API_KEY: properties.getProperty('NAVER_API_KEY') ? '정상' : '없음',
    NAVER_SECRET_KEY: properties.getProperty('NAVER_SECRET_KEY') ? '정상' : '없음',
    NAVER_CUSTOMER_ID: properties.getProperty('NAVER_CUSTOMER_ID') ? '정상' : '없음'
  };
  console.log(JSON.stringify(result, null, 2));
}

const NAVER_BASE_URL = 'https://api.searchad.naver.com';
const OUTPUT_SHEET_NAME = 'Adriel_연동';
const SHOPPING_CREATIVE_SHEET_NAME = '네이버_쇼핑소재';
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

function buildQueryString_(params = {}) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

function naverGetBatch_(requests, batchSize = 20) {
  const results = [];
  for (let start = 0; start < requests.length; start += batchSize) {
    const batch = requests.slice(start, start + batchSize);
    const fetchRequests = batch.map(request => {
      const query = buildQueryString_(request.params);
      return {
        url: NAVER_BASE_URL + request.uri + (query ? `?${query}` : ''),
        method: 'get',
        headers: getNaverHeaders_('GET', request.uri),
        muteHttpExceptions: true
      };
    });
    const responses = UrlFetchApp.fetchAll(fetchRequests);
    responses.forEach((response, index) => {
      const statusCode = response.getResponseCode();
      const body = response.getContentText();
      if (statusCode !== 200) {
        const request = batch[index];
        throw new Error(
          `네이버 API 오류 ${statusCode}\n요청: ${request.uri}\n응답: ${body}`
        );
      }
      results.push(JSON.parse(body));
    });
    if (start + batchSize < requests.length) Utilities.sleep(300);
  }
  return results;
}

function parseJsonValue_(value) {
  if (value === null || value === undefined || value === '') return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return { rawValue: String(value) };
  }
}

function firstValue_(values) {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== '') return value;
  }
  return '';
}

function sheetCellValue_(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : value;
}

function extractExtensionText_(extensionData) {
  const texts = [];
  const textKeys = new Set([
    'description', 'additionalText', 'basicText', 'text',
    'headline', 'heading', 'name', 'title'
  ]);
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    Object.entries(value).forEach(([key, child]) => {
      if (textKeys.has(key) && (typeof child === 'string' || typeof child === 'number')) {
        const text = String(child).trim();
        if (text && !texts.includes(text)) texts.push(text);
      } else if (typeof child === 'object') {
        visit(child);
      }
    });
  }
  visit(extensionData);
  return texts.join(' | ');
}

function buildNaverShoppingCreativeExtensions() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('이미 동일한 업데이트가 실행 중입니다.');
  try {
    const campaigns = naverGet_('/ncc/campaigns');
    const adgroups = naverGet_('/ncc/adgroups');
    const shoppingCampaigns = campaigns.filter(
      campaign => campaign.campaignTp === 'SHOPPING'
    );
    const campaignMap = {};
    shoppingCampaigns.forEach(campaign => {
      campaignMap[campaign.nccCampaignId] = campaign;
    });
    const shoppingAdgroups = adgroups.filter(
      adgroup => Boolean(campaignMap[adgroup.nccCampaignId])
    );

    const adLists = naverGetBatch_(shoppingAdgroups.map(adgroup => ({
      uri: '/ncc/ads',
      params: { nccAdgroupId: adgroup.nccAdgroupId }
    })));
    const ads = [];
    adLists.forEach((adList, index) => {
      const adgroup = shoppingAdgroups[index];
      adList.forEach(ad => ads.push({ ad, adgroup }));
    });

    const extensionLists = naverGetBatch_(ads.map(item => ({
      uri: '/ncc/ad-extensions',
      params: { ownerId: item.ad.nccAdId }
    })));
    const output = [];
    ads.forEach((item, index) => {
      const ad = item.ad;
      const adgroup = item.adgroup;
      const campaign = campaignMap[adgroup.nccCampaignId];
      const adData = parseJsonValue_(ad.ad);
      const adAttr = parseJsonValue_(ad.adAttr);
      const extensions = extensionLists[index] || [];
      const productName = firstValue_([
        adData.productName, adData.name, adData.title,
        adData.product && adData.product.name
      ]);
      const imageUrl = firstValue_([
        adData.imageUrl, adData.imagePath, adData.image,
        adData.product && (adData.product.imageUrl || adData.product.image)
      ]);
      const productId = firstValue_([
        adData.productId, adData.nvmid, adData.nvMid,
        adData.product && (adData.product.id || adData.product.productId)
      ]);
      const extensionRows = extensions.length ? extensions : [null];
      extensionRows.forEach(extension => {
        const extensionData = extension ? parseJsonValue_(extension.adExtension) : {};
        output.push([
          campaign.name || '',
          campaign.nccCampaignId || '',
          adgroup.name || '',
          adgroup.nccAdgroupId || '',
          ad.nccAdId || '',
          ad.type || '',
          sheetCellValue_(productName),
          sheetCellValue_(productId),
          sheetCellValue_(imageUrl),
          firstValue_([adAttr.bidAmt, adData.bidAmt]),
          firstValue_([adAttr.useGroupBidAmt, adData.useGroupBidAmt]),
          ad.status || '',
          ad.statusReason || '',
          ad.inspectStatus || '',
          extension ? extension.nccAdExtensionId || '' : '',
          extension ? extension.type || '' : '',
          extension ? extractExtensionText_(extensionData) : '',
          extension ? extension.status || '' : '',
          extension ? extension.statusReason || '' : '',
          extension ? extension.inspectStatus || '' : '',
          extension ? extension.userLock : '',
          extension ? extension.periodStartDt || '' : '',
          extension ? extension.periodEndDt || '' : '',
          extension ? extension.regTm || '' : '',
          extension ? extension.editTm || '' : '',
          JSON.stringify(adData),
          extension ? JSON.stringify(extensionData) : ''
        ]);
      });
    });
    output.sort((a, b) =>
      String(a[0]).localeCompare(String(b[0])) ||
      String(a[2]).localeCompare(String(b[2])) ||
      String(a[4]).localeCompare(String(b[4])) ||
      String(a[15]).localeCompare(String(b[15]))
    );
    writeShoppingCreativeSheet_(output);
    console.log(
      `쇼핑검색 소재 업데이트 완료: 캠페인 ${shoppingCampaigns.length}개, ` +
      `광고그룹 ${shoppingAdgroups.length}개, 소재 ${ads.length}개, 출력 ${output.length}행`
    );
  } finally {
    lock.releaseLock();
  }
}

function writeShoppingCreativeSheet_(output) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName(SHOPPING_CREATIVE_SHEET_NAME) ||
    spreadsheet.insertSheet(SHOPPING_CREATIVE_SHEET_NAME);
  const headers = [
    '캠페인', '캠페인ID', '광고그룹', '광고그룹ID', '소재ID', '소재유형',
    '상품명', '상품ID', '이미지URL', '소재입찰가', '그룹입찰가사용',
    '소재상태', '소재상태사유', '소재검토상태',
    '확장소재ID', '확장소재유형', '추가홍보문구/확장소재내용',
    '확장소재상태', '확장소재상태사유', '확장소재검토상태', '확장소재중지',
    '노출시작일', '노출종료일', '확장소재등록일', '확장소재수정일',
    '소재원본JSON', '확장소재원본JSON'
  ];
  const existingFilter = sheet.getFilter();
  if (existingFilter) existingFilter.remove();
  sheet.clearContents();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (!output.length) {
    sheet.getRange(2, 1).setValue('조회 가능한 쇼핑검색 광고 소재가 없습니다.');
    return;
  }
  sheet.getRange(2, 1, output.length, headers.length).setValues(output);
  [2, 4, 5, 8, 15].forEach(column =>
    sheet.getRange(2, column, output.length, 1).setNumberFormat('@')
  );
  sheet.getRange(2, 10, output.length, 1).setNumberFormat('#,##0');
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length).createFilter();
  sheet.autoResizeColumns(1, headers.length);
  SpreadsheetApp.flush();
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
    // 취소 계약은 원래 계약 종료일까지 비용이 생성될 수 있으므로 제외한다.
    // 과거 실적은 정상적으로 노출이 완료된 계약(EXPOSE_COMPLETED)만 포함한다.
    const allowedStatuses = [
      'UPCOMING_EXPOSE', 'ON_EXPOSING', 'EXPOSE_COMPLETED'
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
        // 실제 노출 기간을 우선 사용한다. 정상 계약인데 실제 노출일이
        // 비어 있는 API 응답은 계약 시작·종료일을 보조값으로 사용한다.
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
        // 입력RAW의 계산 방식과 맞추기 위해 일별 금액을 반올림한다.
        const dailyCost = Math.round(totalCostExVat / contractDays);
        for (let dayIndex = 0; dayIndex < outputDays; dayIndex++) {
          const currentDate = new Date(
            startDate.getTime() + dayIndex * MILLISECONDS_PER_DAY
          );
          const dateText = Utilities.formatDate(currentDate, TIME_ZONE, 'yyyy-MM-dd');
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

const PROMOTION_AUDIT_API_URL = 'https://api.searchad.naver.com';
const PROMOTION_AUDIT_SHEET = '네이버_PROMOTION확인';
const PROMOTION_AUDIT_BATCH_SIZE = 5;
const PROMOTION_AUDIT_BATCH_INTERVAL_MS = 1000;
const PROMOTION_AUDIT_MAX_RETRIES = 5;

function promotionAuditCreateSignature_(timestamp, method, uri, secretKey) {
  const message = `${timestamp}.${method}.${uri}`;
  const bytes = Utilities.computeHmacSha256Signature(
    message, secretKey, Utilities.Charset.UTF_8
  );
  return Utilities.base64Encode(bytes);
}

function promotionAuditGetCredentials_() {
  const properties = PropertiesService.getScriptProperties();
  const credentials = {
    apiKey: properties.getProperty('NAVER_API_KEY'),
    secretKey: properties.getProperty('NAVER_SECRET_KEY'),
    customerId: properties.getProperty('NAVER_CUSTOMER_ID')
  };
  const missing = Object.entries(credentials)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length) {
    throw new Error(`네이버 API 인증정보가 없습니다: ${missing.join(', ')}`);
  }
  return credentials;
}

function promotionAuditGetHeaders_(method, uri) {
  const credentials = promotionAuditGetCredentials_();
  const timestamp = String(Date.now());
  return {
    'Content-Type': 'application/json; charset=UTF-8',
    'X-Timestamp': timestamp,
    'X-API-KEY': credentials.apiKey,
    'X-Customer': credentials.customerId,
    'X-Signature': promotionAuditCreateSignature_(
      timestamp, method, uri, credentials.secretKey
    )
  };
}

function promotionAuditCreateQuery_(params = {}) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

function promotionAuditGetWithRetry_(uri, params = {}) {
  const query = promotionAuditCreateQuery_(params);
  const url = PROMOTION_AUDIT_API_URL + uri + (query ? `?${query}` : '');
  for (let attempt = 0; attempt <= PROMOTION_AUDIT_MAX_RETRIES; attempt++) {
    const response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: promotionAuditGetHeaders_('GET', uri),
      muteHttpExceptions: true
    });
    const statusCode = response.getResponseCode();
    const body = response.getContentText();
    if (statusCode === 200) return JSON.parse(body);
    if (statusCode !== 429 || attempt === PROMOTION_AUDIT_MAX_RETRIES) {
      throw new Error(`네이버 API 오류 ${statusCode}\n요청: ${uri}\n응답: ${body}`);
    }
    const waitMilliseconds = Math.min(32000, 2000 * Math.pow(2, attempt));
    console.log(
      `429 응답: ${uri}, ${waitMilliseconds / 1000}초 후 재시도 ` +
      `(${attempt + 1}/${PROMOTION_AUDIT_MAX_RETRIES})`
    );
    Utilities.sleep(waitMilliseconds);
  }
  throw new Error(`네이버 API 재시도 실패: ${uri}`);
}

function promotionAuditGetBatch_(requests) {
  const results = [];
  for (let start = 0; start < requests.length; start += PROMOTION_AUDIT_BATCH_SIZE) {
    const batch = requests.slice(start, start + PROMOTION_AUDIT_BATCH_SIZE);
    const fetchRequests = batch.map(request => {
      const query = promotionAuditCreateQuery_(request.params);
      return {
        url: PROMOTION_AUDIT_API_URL + request.uri + (query ? `?${query}` : ''),
        method: 'get',
        headers: promotionAuditGetHeaders_('GET', request.uri),
        muteHttpExceptions: true
      };
    });
    const responses = UrlFetchApp.fetchAll(fetchRequests);
    responses.forEach((response, index) => {
      const request = batch[index];
      const statusCode = response.getResponseCode();
      const body = response.getContentText();
      if (statusCode === 200) {
        results.push(JSON.parse(body));
        return;
      }
      if (statusCode === 429) {
        Utilities.sleep(2000);
        results.push(promotionAuditGetWithRetry_(request.uri, request.params));
        return;
      }
      throw new Error(`네이버 API 오류 ${statusCode}\n요청: ${request.uri}\n응답: ${body}`);
    });
    if (start + PROMOTION_AUDIT_BATCH_SIZE < requests.length) {
      Utilities.sleep(PROMOTION_AUDIT_BATCH_INTERVAL_MS);
    }
  }
  return results;
}

function promotionAuditParseJson_(value) {
  if (value === null || value === undefined || value === '') return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return {};
  }
}

function promotionAuditFirstValue_(values) {
  for (const value of values) {
    if (value !== null && value !== undefined && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return '';
}

function promotionAuditFindProductName_(value) {
  if (!value || typeof value !== 'object') return '';
  const keys = [
    'productName', 'adProductName', 'displayProductName', 'mallProductName',
    'shoppingProductName', 'nvProductName', 'productTitle'
  ];
  for (const key of keys) {
    if (value[key] !== null && value[key] !== undefined && String(value[key]).trim()) {
      return String(value[key]).trim();
    }
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const found = promotionAuditFindProductName_(child);
      if (found) return found;
    }
  }
  return '';
}

function promotionAuditGetProductName_(ad) {
  const adData = promotionAuditParseJson_(ad.ad);
  const referenceData = promotionAuditParseJson_(ad.referenceData);
  return promotionAuditFirstValue_([
    ad.productName,
    ad.adProductName,
    ad.displayProductName,
    promotionAuditFindProductName_(adData),
    promotionAuditFindProductName_(referenceData)
  ]);
}

function promotionAuditGetExtensionText_(extension) {
  if (!extension) return '';
  const extensionData = promotionAuditParseJson_(extension.adExtension);
  const referenceData = promotionAuditParseJson_(extension.referenceData);
  const texts = [];
  const textKeys = new Set([
    'description', 'additionalText', 'basicText', 'text',
    'headline', 'heading', 'name', 'title'
  ]);
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    Object.entries(value).forEach(([key, child]) => {
      if (
        textKeys.has(key) &&
        (typeof child === 'string' || typeof child === 'number')
      ) {
        const text = String(child).trim();
        if (text && !texts.includes(text)) texts.push(text);
      } else if (child && typeof child === 'object') {
        visit(child);
      }
    });
  }
  visit(extensionData);
  visit(referenceData);
  return texts.join(' | ');
}

function promotionAuditIsExcludedAdgroup_(name) {
  return /h-s$/i.test(String(name || '').trim());
}

/**
 * 활성 쇼핑검색 소재 중 PROMOTION 확장소재가 있거나,
 * SHOPPING_EXTRA를 제외하면 확장소재가 없는 소재를 시트에 적재한다.
 */
function buildNaverPromotionCheck() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('이미 동일한 업데이트가 실행 중입니다.');
  try {
    const campaigns = promotionAuditGetWithRetry_('/ncc/campaigns');
    const adgroups = promotionAuditGetWithRetry_('/ncc/adgroups');
    const campaignMap = {};
    campaigns
      .filter(campaign =>
        campaign.campaignTp === 'SHOPPING' &&
        campaign.userLock !== true &&
        campaign.status === 'ELIGIBLE'
      )
      .forEach(campaign => {
        campaignMap[campaign.nccCampaignId] = campaign;
      });

    const targetAdgroups = adgroups.filter(adgroup =>
      Boolean(campaignMap[adgroup.nccCampaignId]) &&
      adgroup.userLock !== true &&
      adgroup.status === 'ELIGIBLE' &&
      !promotionAuditIsExcludedAdgroup_(adgroup.name)
    );

    const adLists = promotionAuditGetBatch_(targetAdgroups.map(adgroup => ({
      uri: '/ncc/ads',
      params: { nccAdgroupId: adgroup.nccAdgroupId }
    })));
    const ads = [];
    adLists.forEach((adList, index) => {
      const adgroup = targetAdgroups[index];
      adList
        .filter(ad => ad.userLock !== true && ad.status === 'ELIGIBLE')
        .forEach(ad => ads.push({ ad, adgroup }));
    });

    const extensionLists = promotionAuditGetBatch_(ads.map(item => ({
      uri: '/ncc/ad-extensions',
      params: { ownerId: item.ad.nccAdId }
    })));

    const missingNameIndexes = [];
    ads.forEach((item, index) => {
      if (!promotionAuditGetProductName_(item.ad)) missingNameIndexes.push(index);
    });
    if (missingNameIndexes.length) {
      const detailedAds = promotionAuditGetBatch_(missingNameIndexes.map(index => ({
        uri: `/ncc/ads/${ads[index].ad.nccAdId}`,
        params: {}
      })));
      detailedAds.forEach((detailedAd, index) => {
        const originalIndex = missingNameIndexes[index];
        ads[originalIndex].ad = Object.assign({}, ads[originalIndex].ad, detailedAd);
      });
    }

    const output = [];
    ads.forEach((item, index) => {
      const { ad, adgroup } = item;
      const campaign = campaignMap[adgroup.nccCampaignId];
      const productName = promotionAuditGetProductName_(ad) || '상품명 API 미제공';
      const usableExtensions = (extensionLists[index] || []).filter(
        extension => extension.type !== 'SHOPPING_EXTRA'
      );
      const promotions = usableExtensions.filter(
        extension => extension.type === 'PROMOTION'
      );

      if (promotions.length) {
        promotions.forEach(extension => output.push([
          campaign.name || '',
          adgroup.name || '',
          ad.nccAdId || '',
          productName,
          extension.nccAdExtensionId || '',
          'PROMOTION',
          promotionAuditGetExtensionText_(extension),
          extension.status || '',
          extension.inspectStatus || ''
        ]));
      } else if (!usableExtensions.length) {
        output.push([
          campaign.name || '',
          adgroup.name || '',
          ad.nccAdId || '',
          productName,
          '',
          '확장소재 없음',
          '',
          '',
          ''
        ]);
      }
    });

    output.sort((a, b) =>
      String(a[0]).localeCompare(String(b[0])) ||
      String(a[1]).localeCompare(String(b[1])) ||
      String(a[3]).localeCompare(String(b[3])) ||
      String(a[5]).localeCompare(String(b[5]))
    );
    promotionAuditWriteSheet_(output);
    console.log(`PROMOTION 점검 완료: ${output.length}행`);
  } finally {
    lock.releaseLock();
  }
}

function promotionAuditWriteSheet_(output) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName(PROMOTION_AUDIT_SHEET) ||
    spreadsheet.insertSheet(PROMOTION_AUDIT_SHEET);
  const headers = [
    '캠페인', '광고그룹', '소재ID', '상품명', '확장소재ID',
    '확장소재유형', '확장소재내용', '확장소재상태', '확장소재검토상태'
  ];
  const existingFilter = sheet.getFilter();
  if (existingFilter) existingFilter.remove();
  sheet.clearContents();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (!output.length) {
    sheet.getRange(2, 1).setValue('PROMOTION 또는 확장소재 없는 소재가 없습니다.');
    return;
  }
  sheet.getRange(2, 1, output.length, headers.length).setValues(output);
  sheet.getRange(2, 3, output.length, 1).setNumberFormat('@');
  sheet.getRange(2, 5, output.length, 1).setNumberFormat('@');
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length).createFilter();
  sheet.autoResizeColumns(1, headers.length);
  SpreadsheetApp.flush();
}

export const EXECUTION_ALLOWLIST: readonly string[] = [
  'getBalance',
  'getMidMarketRate',
  'createQuote',
  'createBalanceConversion',
  'getBalanceConversions',

  'validateBankAccount',
  'getBankAccountValidations',

  'createCustomer',
  'getCustomers',
  'getCustomerById',
  'updateCustomer',
  'createCustomerBankAccount',
  'getCustomerBankAccounts',

  'createDocument',
  'getDocuments',
  'getDocumentById',

  'listKycLinks',
  'createKycLink',
  'getKycLinkById',
  'createInvestorJourney',

  'createOrder',
  'getOrders',
  'getOrderById',
  'updateOrderRfi',

  'createPayin',
  'getPayins',
  'getPayinById',
  'updatePayin',
  'cancelPayin',
  'updatePayinRfi',
  'mockReviewPaymentLink',

  'createPayment',
  'getPayments',
  'getPaymentById',
  'createPaymentSession',
  'connectPayin',
  'getEligiblePayins',
  'createMockPayment',
  'mockUpdatePaymentFundsAvailable',

  'createPayout',
  'getPayouts',
  'getPayoutById',
  'cancelPayout',
  'updateRfiPayout',
  'mockUpdatePayoutStatus',

  'createPrice',
  'getPrices',
  'getPriceById',
  'getDynamicPrices',
  'createPricingSplit',
  'getPricingSplits',

  'createRefund',
  'getRefunds',
  'getRefundById',
  'mockUpdateRefund',

  'getRfis',
  'getRfi',
  'respondRfi',

  'createSettlement',
  'getSettlements',
  'getSettlementById',
  'getTransactionsLinkedToSettlement',
  'triggerMockSettlement',

  'getSubscriptions',
  'createSubscription',
  'getSubscriptionById',
  'cancelSubscription',
  'updateNextPaymentDate',
  'pauseSubscription',
  'resumeSubscription',

  'createBeneficiaryV2',
  'listBeneficiariesV2',
  'getBeneficiaryByIdV2',
  'mockReviewBeneficiaryV2',

  'createVirtualAccountV2',
  'getVirtualAccounts',
  'closeVirtualAccount',

  'createInternalTransfer',

  'onboardMerchant',
  'getMerchant',
  'updateMerchant',
  'updateMerchantStatus',

  'rotateApiKey',
];

export const executionAllowlist: ReadonlySet<string> = new Set(EXECUTION_ALLOWLIST);

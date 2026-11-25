export interface UserModelPlanOffer { name: string; description?: string; price: string; url: string }
export interface UserModelPlans { url: string; offers: UserModelPlanOffer[] }

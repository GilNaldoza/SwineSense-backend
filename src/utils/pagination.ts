
export interface PaginationParams {
    page: number;
    limit: number;
}

export interface PaginatedResult<T> {
    data: T[];
    meta: {
        total: number;
        page: number;
        limit: number;
        totalPages: number;
        hasNextPage: boolean;
        hasPrevPage: boolean;
    };
}

export const getPaginationParams = (query: any): PaginationParams => {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 10)); // Default 10, max 100
    return { page, limit };
};

export const paginate = async <T>(
    model: any,
    args: any = {},
    { page, limit }: PaginationParams,
    dataKey: string = 'items'
): Promise<any> => { // Return type relaxed to any to match legacy structure flexibility
    const skip = (page - 1) * limit;

    const [total, rows] = await Promise.all([
        model.count({ where: args.where }),
        model.findMany({
            ...args,
            skip,
            take: limit,
        }),
    ]);

    const totalPages = Math.ceil(total / limit);

    return {
        success: true,
        data: {
            [dataKey]: rows,
            pagination: {
                total,
                page,
                limit,
                totalPages,
                hasNextPage: page < totalPages,
                hasPrevPage: page > 1
            }
        }
    };
};
